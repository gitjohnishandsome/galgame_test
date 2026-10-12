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
HOST, PORT = "127.0.0.1", 8010
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
ASSET_DIRS = ["bg", "cg", "chars", "bgm", "se", "voice"]
ASSET_EXT = {".webp", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".mp3", ".ogg", ".wav", ".m4a"}
MAX_BODY = 2 * 1024 * 1024


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
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"編輯器已啟動：http://{HOST}:{PORT}/tools/editor/index.html")
    print("要關閉請按 Ctrl+C 或直接關掉這個視窗。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
