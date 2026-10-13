"""
場景編輯器的本機伺服器（只給自己的電腦用）

啟動：雙擊「啟動編輯器.bat」，或執行  python tools/editor_server.py
然後打開  http://127.0.0.1:8010/tools/editor/index.html

它做兩件事：
  1. 把整個專案資料夾當靜態網站提供（和 start.bat 一樣，編輯器的預覽用的就是真正的遊戲）。
  2. 提供讓編輯器「讀 / 寫劇情檔」的小 API。

安全：只綁定 127.0.0.1（別台電腦連不到）、檢查 Host / Origin、只允許寫 chapters/<id>.txt，
每次儲存前先把舊檔備份到 tools/editor_backups/。
"""
import json
import os
import re
import shutil
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
CHAPTERS = ROOT / "chapters"
BACKUPS = ROOT / "tools" / "editor_backups"
HOST, PORT = "127.0.0.1", int(os.environ.get("EDITOR_PORT", "8010"))   # 平常用 8010；EDITOR_PORT 只給測試用
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
ASSET_DIRS = ["bg", "cg", "chars", "bgm", "se", "voice"]
ASSET_EXT = {".webp", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".mp3", ".ogg", ".wav", ".m4a"}
MAX_BODY = 2 * 1024 * 1024
UPLOAD_MAX = 80 * 1024 * 1024                         # 單一音檔上限
UPLOAD_DIRS = {"bgm", "se", "voice"}
UPLOAD_EXT = {".mp3", ".ogg", ".wav", ".m4a"}


class Server(ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 會讓好幾個程式同時綁定同一個埠，請求被隨機分給新舊伺服器，
    # 所以這裡改成獨佔，已經有一個編輯器在跑時，第二個會直接報錯結束
    allow_reuse_address = False

    def server_bind(self):
        if sys.platform == "win32":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---- 共用 ----
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 注意：404 / 501 等錯誤回應傳進來的第一個參數是數字，要先組成字串再比對，否則會當掉、連線被中斷
        line = fmt % args if args else str(fmt)
        if "/api/" in line:
            sys.stderr.write("[api] " + line + "\n")

    def host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def fail(self, status, msg):
        self.send_json({"error": msg}, status)

    # ---- GET ----
    def do_GET(self):
        if not self.host_ok():
            return self.fail(403, "bad host")
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/"):
            return super().do_GET()
        if path == "/api/assets":
            return self.send_json(list_assets())
        m = re.fullmatch(r"/api/chapter/([^/]+)", path)
        if m:
            cid = m.group(1)
            if not ID_RE.match(cid):
                return self.fail(400, "bad chapter id")
            f = CHAPTERS / f"{cid}.txt"
            if not f.exists():
                return self.fail(404, "chapter not found")
            return self.send_json({"id": cid, "text": f.read_text(encoding="utf-8")})
        return self.fail(404, "unknown api")

    # ---- PUT ----
    def do_PUT(self):
        if not self.host_ok() or self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self.fail(403, "forbidden")
        path = unquote(urlparse(self.path).path)
        m = re.fullmatch(r"/api/chapter/([^/]+)", path)
        if not m or not ID_RE.match(m.group(1)):
            return self.fail(400, "bad request")
        cid = m.group(1)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.fail(400, "bad length")
        if n <= 0 or n > MAX_BODY:
            return self.fail(413, "body too large")
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            text = body["text"]
            if not isinstance(text, str):
                raise ValueError
        except Exception:
            return self.fail(400, "bad json")
        f = CHAPTERS / f"{cid}.txt"
        if not f.exists():
            return self.fail(404, "chapter not found")
        old = f.read_bytes()
        BACKUPS.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(f, BACKUPS / f"{cid}_{time.strftime('%Y%m%d_%H%M%S')}.txt")
        nl = "\r\n" if b"\r\n" in old else "\n"          # 沿用原檔的換行格式
        data = text.replace("\r\n", "\n").replace("\n", nl).encode("utf-8")
        f.write_bytes(data)
        return self.send_json({"ok": True, "bytes": len(data)})

    # ---- 匯入音檔 ----
    def handle_upload(self):
        try:
            status, msg = handle_upload_impl(self)
        except Exception as e:
            return self.fail(500, f"伺服器錯誤：{e}")
        return self.send_json({"ok": True, "name": msg} if status == 200 else {"error": msg}, status)

    # ---- POST ----
    def do_POST(self):
        if not self.host_ok() or self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self.fail(403, "forbidden")
        if urlparse(self.path).path == "/api/upload":
            return self.handle_upload()
        handlers = {
            "/api/chars/sprite": register_sprite,
            "/api/chars/add": add_character,
            "/api/chapter/new": new_chapter,
            "/api/chapters/save": save_chapters,
        }
        fn = handlers.get(unquote(urlparse(self.path).path))
        if not fn:
            return self.fail(404, "unknown api")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 64 * 1024:
                raise ValueError
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self.fail(400, "bad json")
        try:
            status, msg = fn(body)
        except Exception as e:                                  # 不要讓一個壞請求把連線弄斷
            return self.fail(500, f"伺服器錯誤：{e}")
        return self.send_json({"ok": True} if status == 200 else {"error": msg}, status)


def handle_upload_impl(handler):
    """把音檔存進 assets/bgm、se 或 voice。網址參數：dir、name；內容是檔案本身（二進位）"""
    q = parse_qs(urlparse(handler.path).query)
    d = (q.get("dir") or [""])[0]
    name = (q.get("name") or [""])[0]
    if d not in UPLOAD_DIRS:
        return 400, "不支援的資料夾"
    name = Path(name.replace("\\", "/")).name                    # 只留檔名，去掉任何路徑
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    if not name or name.startswith(".") or ext not in UPLOAD_EXT:
        return 400, "只能匯入 mp3 / ogg / wav / m4a 音訊檔"
    if not re.match(r"^[^<>:\"/\\|?*\x00-\x1f]{1,120}$", name):
        return 400, "檔名含有不能使用的字元"
    try:
        n = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        return 400, "bad length"
    if n <= 0:
        return 400, "檔案是空的"
    if n > UPLOAD_MAX:
        return 413, f"檔案太大（上限 {UPLOAD_MAX // 1024 // 1024} MB）"
    target = ROOT / "assets" / d / (stem + ext)
    if target.exists():
        return 409, f"assets/{d}/ 裡已經有「{target.name}」了，請先改檔名再匯入"
    target.parent.mkdir(parents=True, exist_ok=True)
    left, tmp = n, target.with_name(target.name + ".part")
    try:
        with tmp.open("wb") as f:
            while left > 0:
                chunk = handler.rfile.read(min(left, 1024 * 256))
                if not chunk:
                    raise IOError("連線中斷")
                f.write(chunk)
                left -= len(chunk)
        tmp.replace(target)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return 500, f"寫入失敗：{e}"
    return 200, target.name


def register_sprite(body):
    """在 chars.json 的某個角色底下新增 / 更新一個表情 → 檔名"""
    char, expr, fname = body.get("char"), body.get("expr"), body.get("file")
    if not all(isinstance(x, str) for x in (char, expr, fname)):
        return 400, "參數錯誤"
    expr = expr.strip()
    if not expr or len(expr) > 30 or re.search(r"\s", expr):
        return 400, "表情名稱不可空白、不可含空格，且不超過 30 字"
    if "/" in fname or "\\" in fname or ".." in fname or not (ROOT / "assets" / "chars" / fname).is_file():
        return 400, "找不到這個立繪檔案"
    f = ROOT / "chars.json"
    raw = f.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    if char not in data:
        return 404, "chars.json 裡沒有這個角色"
    BACKUPS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(f, BACKUPS / f"chars_{time.strftime('%Y%m%d_%H%M%S')}.json")
    data[char].setdefault("sprites", {})[expr] = fname
    nl = "\r\n" if b"\r\n" in raw else "\n"
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    f.write_bytes(text.replace("\n", nl).encode("utf-8"))
    return 200, "ok"


def read_json_file(f):
    raw = f.read_bytes()
    return json.loads(raw.decode("utf-8")), raw


def write_json_file(f, data, raw_old):
    """備份舊檔後寫入，沿用原檔的換行格式"""
    BACKUPS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(f, BACKUPS / f"{f.stem}_{time.strftime('%Y%m%d_%H%M%S')}{f.suffix}")
    nl = "\r\n" if b"\r\n" in raw_old else "\n"
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    f.write_bytes(text.replace("\n", nl).encode("utf-8"))


CHAR_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,29}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def add_character(body):
    """新增角色：id、顯示名稱、名字顏色（立繪之後再登記）"""
    cid, name, color = body.get("id"), body.get("name"), body.get("color", "#ffffff")
    if not all(isinstance(x, str) for x in (cid, name, color)):
        return 400, "參數錯誤"
    name = name.strip()
    if not CHAR_ID_RE.match(cid):
        return 400, "角色 id 只能用英文字母、數字、底線，並以英文字母開頭（最多 30 字）"
    if not name or len(name) > 12 or "：" in name or ":" in name:
        return 400, "名稱不可空白、不可超過 12 字、不可含冒號（劇情用「名稱：台詞」辨識說話者）"
    if not COLOR_RE.match(color):
        return 400, "顏色格式要像 #ffd6a5"
    f = ROOT / "chars.json"
    data, raw = read_json_file(f)
    if cid in data:
        return 400, "已經有這個角色 id 了"
    if any(v.get("name") == name for v in data.values()):
        return 400, "已經有同名的角色了"
    data[cid] = {"name": name, "color": color.lower(), "sprites": {}}
    write_json_file(f, data, raw)
    return 200, "ok"


def new_chapter(body):
    """新增章節檔（附簡單的開頭範本），並加到 chapters/index.json 的最後面"""
    cid, title = body.get("id"), body.get("title")
    if not isinstance(cid, str) or not isinstance(title, str):
        return 400, "參數錯誤"
    title = title.strip()
    if not ID_RE.match(cid) or not re.match(r"^[A-Za-z]", cid):
        return 400, "章節 id 只能用英文字母、數字、底線、連字號，並以英文字母開頭，例如 ch3"
    if not title or len(title) > 40 or "\n" in title:
        return 400, "章節標題不可空白，且不超過 40 字"
    f = CHAPTERS / f"{cid}.txt"
    if f.exists():
        return 400, "這個章節檔已經存在"
    idx = CHAPTERS / "index.json"
    data, raw = read_json_file(idx)
    if any(c.get("id") == cid for c in data.get("chapters", [])):
        return 400, "章節清單裡已經有這個 id 了"
    f.write_text(f"# {title}\n@title {title}\n\n", encoding="utf-8", newline="")
    data.setdefault("chapters", []).append({"id": cid, "title": title})
    write_json_file(idx, data, raw)
    return 200, "ok"


def save_chapters(body):
    """調整章節順序與標題。只允許「換順序、改標題」，章節清單的 id 必須和現有的完全一樣"""
    items = body.get("chapters")
    if not isinstance(items, list):
        return 400, "參數錯誤"
    idx = CHAPTERS / "index.json"
    data, raw = read_json_file(idx)
    old_ids = [c.get("id") for c in data.get("chapters", [])]
    new_ids = [c.get("id") for c in items if isinstance(c, dict)]
    if sorted(map(str, new_ids)) != sorted(map(str, old_ids)):
        return 400, "章節清單和現有的不一致（本功能只能調整順序與標題，不能新增或刪除章節）"
    clean = []
    for c in items:
        title = c.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 40 or "\n" in title:
            return 400, "章節標題不可空白，且不超過 40 字"
        clean.append({"id": c["id"], "title": title.strip()})
    data["chapters"] = clean
    write_json_file(idx, data, raw)
    return 200, "ok"


def list_assets():
    out = {}
    for d in ASSET_DIRS:
        base = ROOT / "assets" / d
        items = []
        if base.exists():
            for p in sorted(base.rglob("*")):
                if p.is_file() and p.suffix.lower() in ASSET_EXT:
                    items.append({"name": p.relative_to(base).as_posix(), "size": p.stat().st_size})
        out[d] = items
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        srv = Server((HOST, PORT), Handler)
    except OSError:
        print(f"埠 {PORT} 已經有另一個編輯器在執行了，直接用瀏覽器打開 http://{HOST}:{PORT}/tools/editor/index.html 即可。")
        print("（如果畫面不對，請先把舊的黑色視窗關掉，再重新啟動。）")
        return
    print(f"編輯器已啟動：http://{HOST}:{PORT}/tools/editor/index.html")
    print("要關閉請按 Ctrl+C 或直接關掉這個視窗。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
