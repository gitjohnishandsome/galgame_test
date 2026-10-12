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
from urllib.parse import unquote, urlparse

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
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("[api] " + fmt % args + "\n")

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

    # ---- POST ----
    def do_POST(self):
        if not self.host_ok() or self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self.fail(403, "forbidden")
        if unquote(urlparse(self.path).path) != "/api/chars/sprite":
            return self.fail(404, "unknown api")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 4096:
                raise ValueError
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self.fail(400, "bad json")
        status, msg = register_sprite(body)
        return self.send_json({"ok": True} if status == 200 else {"error": msg}, status)


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
