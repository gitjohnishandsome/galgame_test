# 產生「焦糖未乾」標題 logo（透明背景 PNG）。用法：python tools/make_logo.py
import math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

S = 2                      # 超取樣倍率
W, H = 760 * S, 560 * S
FONT_CJK = r"C:\Windows\Fonts\msjhbd.ttc"
FONT_EN = r"C:\Windows\Fonts\arialbd.ttf"
OUT = r"C:\my_galgame\assets\bg\logo.png"

def font(p, size): return ImageFont.truetype(p, size * S)

def gradient(box, top, bot):
    w, h = box
    g = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return g

def text_mask(txt, f, pos, stroke=0):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).text(pos, txt, font=f, fill=255, stroke_width=stroke * S, anchor="ls")
    return m

def paint(canvas, mask, color):
    canvas.paste(Image.new("RGBA", (W, H), color), (0, 0), mask)

def soften(mask, r=3):          # 讓字角變圓
    m = mask.filter(ImageFilter.GaussianBlur(r * S))
    return m.point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.GaussianBlur(.6 * S))

img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# 每個字：(字, x, y, 字級, 上色, 下色, 傾斜度)
chars = [
    ("焦", 70, 235, 190, (255, 214, 120), (240, 140, 50)),
    ("糖", 285, 215, 190, (255, 200, 170), (238, 120, 120)),
    ("未", 100, 420, 160, (255, 236, 170), (245, 170, 60)),
    ("乾", 270, 430, 160, (190, 235, 205), (90, 190, 150)),
]
shadow = Image.new("L", (W, H), 0)
outer_all = Image.new("L", (W, H), 0)
layers = []
for ch, x, y, sz, c1, c2 in chars:
    f = font(FONT_CJK, sz)
    pos = (x * S, y * S)
    core = soften(text_mask(ch, f, pos, 3), 3)
    brown = soften(text_mask(ch, f, pos, 13), 4)
    white = soften(text_mask(ch, f, pos, 24), 5)
    layers.append((white, brown, core, c1, c2))
    outer_all = ImageChops.lighter(outer_all, white)

# 陰影
sh = outer_all.filter(ImageFilter.GaussianBlur(7 * S))
sh = ImageChops.offset(sh, 0, 8 * S).point(lambda v: int(v * .45))
img.paste(Image.new("RGBA", (W, H), (110, 60, 30, 255)), (0, 0), sh)

for white, brown, core, c1, c2 in layers:
    paint(img, white, (255, 255, 255, 255))
    paint(img, brown, (134, 74, 34, 255))
    g = gradient((W, H), c1, c2).convert("RGBA")
    img.paste(g, (0, 0), core)

d = ImageDraw.Draw(img)

def star(cx, cy, r, color, outline=(255, 255, 255, 255)):
    pts = []
    for i in range(8):
        a = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else r * .42
        pts.append((cx * S + rr * S * math.cos(a), cy * S + rr * S * math.sin(a)))
    d.polygon(pts, fill=color, outline=outline, width=3 * S)

def heart(cx, cy, r, color):
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    for sx in (-1, 1):
        md.ellipse([(cx + sx * r * .5 - r * .55) * S, (cy - r * .5) * S, (cx + sx * r * .5 + r * .55) * S, (cy + r * .6) * S], fill=255)
    md.polygon([((cx - r * 1.02) * S, (cy + r * .15) * S), ((cx + r * 1.02) * S, (cy + r * .15) * S), (cx * S, (cy + r * 1.35) * S)], fill=255)
    m = soften(m, 1)
    paint(img, soften(m.filter(ImageFilter.MaxFilter(7)), 1), (255, 255, 255, 255))
    paint(img, m, color)

# 焦糖滴落（從「未乾」下方垂下，與字同色系）
def drip(x, y, w, l, color=(240, 150, 55, 255)):
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    md.rounded_rectangle([(x - w / 2) * S, y * S, (x + w / 2) * S, (y + l) * S], radius=w / 2 * S, fill=255)
    md.ellipse([(x - w * .85) * S, (y + l - w * .9) * S, (x + w * .85) * S, (y + l + w * .8) * S], fill=255)
    m = soften(m, 1)
    paint(img, soften(m.filter(ImageFilter.MaxFilter(15)), 1), (255, 255, 255, 255))
    paint(img, soften(m.filter(ImageFilter.MaxFilter(7)), 1), (134, 74, 34, 255))
    img.paste(gradient((W, H), (255, 190, 90), (225, 120, 40)).convert("RGBA"), (0, 0), m)


# 裝飾
star(60, 90, 30, (255, 226, 120, 255))
star(105, 40, 16, (255, 170, 190, 255))
star(530, 80, 26, (150, 215, 245, 255))
star(560, 170, 14, (255, 226, 120, 255))
heart(560, 400, 26, (255, 150, 170, 255))
heart(60, 310, 18, (255, 170, 190, 255))
star(60, 520, 18, (190, 235, 205, 255))
d = ImageDraw.Draw(img)

# 英文列：圓角色塊 + 白描邊字
bar = Image.new("L", (W, H), 0)
ImageDraw.Draw(bar).rounded_rectangle([50 * S, 488 * S, 520 * S, 548 * S], radius=30 * S, fill=255)
paint(img, soften(bar.filter(ImageFilter.MaxFilter(13)), 1), (255, 255, 255, 255))
img.paste(gradient((W, H), (255, 190, 120), (238, 130, 80)).convert("RGBA"), (0, 0), bar)
fe = font(FONT_EN, 44)
em = Image.new("L", (W, H), 0)
ImageDraw.Draw(em).text((285 * S, 533 * S), "CARAMEL NOT DRY", font=fe, fill=255, anchor="ms")
paint(img, em.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1)).point(lambda v: 255 if v > 90 else 0), (134, 74, 34, 255))
paint(img, em, (255, 255, 255, 255))

img = img.resize((W // S, H // S), Image.LANCZOS)
bbox = img.getchannel("A").getbbox()
img = img.crop(bbox)
img.save(OUT)
print(img.size, OUT)
