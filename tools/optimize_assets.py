"""
素材自動優化工具

用法（在專案資料夾執行，或直接雙擊「優化素材.bat」）：
    python tools/optimize_assets.py              轉檔並更新劇情裡的檔名
    python tools/optimize_assets.py --dry-run    只預覽，不做任何改動
    python tools/optimize_assets.py --check      只檢查素材大小，不轉檔

做了什麼：
  1. 掃描 assets/bg、assets/cg、assets/chars 裡的 PNG / JPG / BMP / TIFF，轉成 WebP。
  2. 過大的圖會縮小到合理尺寸（只縮小，不放大）。
  3. 原圖搬到 raw/（同樣的子資料夾），不會被刪掉；raw/ 已加入 .gitignore，不會上傳到 GitHub。
  4. 自動把 chapters/*.txt、chars.json、chapters/index.json 裡的舊檔名改成新檔名。
  5. 檢查音樂、音效、語音有沒有過大，並統計每一章要下載的素材總量。

不會動：SVG、已經是 WebP 的圖、音訊檔本身。
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
RAW = ROOT / "raw"

IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
IMG_DIRS = ["bg", "cg", "chars"]

# 畫面是 1216x832，背景 / CG 保留約 1.5 倍解析度；立繪顯示高度約 740px，保留約 2 倍
MAX_BG = (1824, 1248)
MAX_CHAR_H = 1480

Q_OPAQUE = 85        # 不透明圖（背景、CG）
Q_SPRITE = 90        # 有透明的立繪
LOGO_ALPHA = 0.20    # bg / cg 內，透明（或半透明）像素超過這個比例的圖，視為 logo / 疊圖，用無損 WebP（畫面和原圖完全一樣）
# 背景、CG 若只有零星的半透明像素（常見於匯出殘留），仍保留透明資訊，但用一般的有損壓縮

AUDIO_LIMITS = {          # 資料夾: (警告大小 MB, 建議)
    "bgm": (5.0, "單曲過大，建議降到 128kbps 的 MP3 / OGG"),
    "se": (0.5, "音效過大"),
    "voice": (0.4, "語音過大，建議降低位元率"),
}
AUDIO_EXT = {".mp3", ".ogg", ".wav", ".m4a", ".flac"}
CHAPTER_BUDGET_MB = 15.0

TEXT_FILES = lambda: sorted((ROOT / "chapters").glob("*.txt")) + [ROOT / "chars.json", ROOT / "chapters" / "index.json"]


def mb(n):
    return f"{n / 1024 / 1024:.2f} MB"


def kb(n):
    return f"{n / 1024:.0f} KB"


def alpha_fraction(im):
    """回傳圖片中「不完全不透明」的像素比例；沒有透明通道則為 0。"""
    if im.mode == "P" and "transparency" in im.info:
        im = im.convert("RGBA")
    if im.mode not in ("RGBA", "LA"):
        return 0.0
    a = im.getchannel("A")
    if a.getextrema()[0] >= 255:
        return 0.0
    hist = a.histogram()
    return sum(hist[:250]) / (im.width * im.height)


def target_size(w, h, folder):
    if folder == "chars":
        if h > MAX_CHAR_H:
            s = MAX_CHAR_H / h
            return round(w * s), MAX_CHAR_H
        return w, h
    s = min(MAX_BG[0] / w, MAX_BG[1] / h, 1)
    return (round(w * s), round(h * s)) if s < 1 else (w, h)


def collect_images():
    out = []
    for d in IMG_DIRS:
        base = ASSETS / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and p.suffix.lower() in IMG_EXT:
                out.append((d, p))
    return out


def convert(folder, src, dry):
    """回傳 (狀態, 新檔 Path 或 None, 說明)"""
    dst = src.with_suffix(".webp")
    if dst.exists():
        return "skip", None, f"已有同名的 {dst.name}，略過"
    with Image.open(src) as im:
        im.load()
        frac = alpha_fraction(im)
        alpha = frac > 0
        w, h = im.size
        nw, nh = target_size(w, h, folder)
        work = im.convert("RGBA" if alpha else "RGB")
        if (nw, nh) != (w, h):
            work = work.resize((nw, nh), Image.LANCZOS)
    lossless = frac > LOGO_ALPHA and folder in ("bg", "cg")
    note = []
    if (nw, nh) != (w, h):
        note.append(f"{w}x{h}→{nw}x{nh}")
    note.append("無損(含透明)" if lossless else f"品質{Q_SPRITE if (alpha and folder == 'chars') else Q_OPAQUE}" + ("，保留透明" if alpha else ""))
    if dry:
        return "dry", dst, "，".join(note)
    kwargs = dict(lossless=True, quality=100, method=6) if lossless else dict(
        quality=Q_SPRITE if (alpha and folder == "chars") else Q_OPAQUE, method=6, alpha_quality=100)
    work.save(dst, "WEBP", **kwargs)
    if dst.stat().st_size >= src.stat().st_size:
        dst.unlink()
        return "skip", None, "轉完沒有比較小，保留原檔"
    return "ok", dst, "，".join(note)


def archive_original(src):
    rel = src.relative_to(ASSETS)
    dest = RAW / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    i = 1
    while dest.exists():
        dest = dest.with_name(f"{rel.stem}_{i}{rel.suffix}")
        i += 1
    shutil.move(str(src), str(dest))
    return dest


def update_refs(renames, dry):
    """把文字檔裡的舊檔名換成新檔名，回傳 {檔案: 次數}"""
    if not renames:
        return {}
    changed = {}
    for f in TEXT_FILES():
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        orig = text
        n = 0
        for old, new in renames.items():
            pat = re.compile(r"(?<![\w\-.])" + re.escape(old) + r"(?![\w\-.])")
            text, k = pat.subn(new, text)
            n += k
        if n and text != orig:
            changed[f.relative_to(ROOT)] = n
            if not dry:
                f.write_text(text, encoding="utf-8", newline="")
    return changed


def ensure_gitignore(dry):
    gi = ROOT / ".gitignore"
    text = gi.read_text(encoding="utf-8") if gi.exists() else ""
    if not re.search(r"^/?raw/?\s*$", text, re.M):
        if not dry:
            with gi.open("a", encoding="utf-8", newline="") as f:
                f.write(("" if text.endswith("\n") or not text else "\n") + "raw/\n")
        return True
    return False


def audio_report():
    print("\n── 音訊檢查 ──")
    bad = 0
    for d, (limit, tip) in AUDIO_LIMITS.items():
        base = ASSETS / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and p.suffix.lower() in AUDIO_EXT:
                size = p.stat().st_size
                flag = ""
                if size > limit * 1024 * 1024:
                    flag = f"  ⚠ {tip}"
                    bad += 1
                elif p.suffix.lower() in (".wav", ".flac") and size > 300 * 1024:
                    flag = "  ⚠ 未壓縮格式，建議轉成 MP3 / OGG"
                    bad += 1
                print(f"  {d}/{p.name}: {mb(size)}{flag}")
    if not bad:
        print("  （沒有發現過大的音訊）")
    else:
        print("  提示：音訊轉檔需要 ffmpeg 或其他音訊軟體（例如 Audacity），本工具不處理音訊本身。")


def chapter_report():
    print("\n── 各章節下載量（劇情裡用到的素材總和）──")
    dirs = {"bg": "bg", "cg": "cg", "pic": "cg", "bgm": "bgm", "se": "se", "voice": "voice"}
    try:
        import json
        chars = json.loads((ROOT / "chars.json").read_text(encoding="utf-8"))
    except Exception:
        chars = {}
    for f in sorted((ROOT / "chapters").glob("*.txt")):
        files = set()
        for line in f.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^@(\w+)\s+(.*)$", line.strip())
            if not m:
                continue
            cmd, args = m.group(1), m.group(2).split()
            if cmd in dirs and args and args[0] != "off":
                files.add(ASSETS / dirs[cmd] / args[0])
            elif cmd == "show" and len(args) >= 2 and args[0] in chars:
                sp = chars[args[0]].get("sprites", {}).get(args[1])
                if sp:
                    files.add(ASSETS / "chars" / sp)
        total, missing = 0, []
        for p in files:
            if p.exists():
                total += p.stat().st_size
            else:
                missing.append(p.name)
        flag = f"  ⚠ 超過建議的 {CHAPTER_BUDGET_MB:.0f} MB" if total > CHAPTER_BUDGET_MB * 1024 * 1024 else ""
        print(f"  {f.name}: {len(files)} 個檔案，{mb(total)}{flag}")
        for name in missing:
            print(f"      ✗ 找不到檔案：{name}")


def main():
    ap = argparse.ArgumentParser(description="素材自動優化工具")
    ap.add_argument("--dry-run", action="store_true", help="只預覽，不做任何改動")
    ap.add_argument("--check", action="store_true", help="只檢查素材大小，不轉檔")
    ap.add_argument("--no-refs", action="store_true", help="不要自動更新劇情裡的檔名")
    args = ap.parse_args()

    if args.check:
        audio_report()
        chapter_report()
        return

    imgs = collect_images()
    if not imgs:
        print("沒有需要轉檔的圖片（assets/bg、cg、chars 裡沒有 PNG / JPG）。")
    renames, before, after = {}, 0, 0
    if imgs:
        print(f"{'[預覽] ' if args.dry_run else ''}找到 {len(imgs)} 張圖片\n")
    for folder, src in imgs:
        old_size = src.stat().st_size
        try:
            status, dst, note = convert(folder, src, args.dry_run)
        except Exception as e:
            print(f"  ✗ {folder}/{src.name}：失敗（{e}）")
            continue
        if status == "ok":
            new_size = dst.stat().st_size
            before += old_size
            after += new_size
            renames[src.name] = dst.name
            archive_original(src)
            print(f"  ✔ {folder}/{src.name}: {kb(old_size)} → {kb(new_size)}（{note}）")
        elif status == "dry":
            renames[src.name] = dst.name
            print(f"  · {folder}/{src.name}: {kb(old_size)} → 轉成 {dst.name}（{note}）")
        else:
            print(f"  - {folder}/{src.name}：{note}")

    if renames and not args.no_refs:
        changed = update_refs(renames, args.dry_run)
        print("\n── 劇情與設定檔裡的檔名更新 ──")
        if changed:
            for f, n in changed.items():
                print(f"  {f}: {n} 處")
        else:
            print("  （沒有檔案提到這些圖，不需要更新）")
    if renames and not args.dry_run and ensure_gitignore(False):
        print("\n已把 raw/ 加入 .gitignore（原圖備份不會上傳）。")

    if before:
        print(f"\n圖片合計：{mb(before)} → {mb(after)}，省下 {mb(before - after)}（{(1 - after / before) * 100:.0f}%）")
        print("原圖已搬到 raw/，確認畫面沒問題後可自行刪除。")

    audio_report()
    chapter_report()


if __name__ == "__main__":
    main()
