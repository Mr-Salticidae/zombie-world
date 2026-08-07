# -*- coding: utf-8 -*-
"""生成 B 站 toy 平台用的封面图 images/logo.png（封面）与 images/banner.jpg（横幅）。
主题配色对齐游戏：暗底 + 血红标题 + 方块头僵尸剪影。重新生成直接运行： python tools/make_cover.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, '..', 'images')
os.makedirs(OUT, exist_ok=True)

# ---- 配色（取自游戏 CSS / 渲染代码）----
BG_TOP   = (21, 23, 28)
BG_MID   = (11, 13, 16)
BG_BOT   = (23, 12, 12)
CREAM    = (242, 239, 228)
RED      = (224, 60, 49)
RED_DK1  = (110, 19, 19)
RED_DK2  = (42, 7, 7)
AMBER    = (255, 179, 62)
GREEN    = (57, 255, 136)
ZHEAD    = (23, 22, 26)
ZBODY    = (239, 237, 231)
ZVNECK   = (170, 182, 194)
INK      = (35, 33, 29)

def font(size, bold=True):
    for name in (('msyhbd.ttc', 'msyh.ttc') if bold else ('msyh.ttc',)):
        p = os.path.join(r'C:\Windows\Fonts', name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient_bg(W, H):
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = lerp(BG_TOP, BG_MID, t / 0.58) if t < 0.58 else lerp(BG_MID, BG_BOT, (t - 0.58) / 0.42)
        for x in range(W):
            px[x, y] = c
    return img

def add_glow(img, cx, cy, r, color, strength):
    """在 (cx,cy) 叠一团径向红光"""
    W, H = img.size
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    steps = 26
    for i in range(steps, 0, -1):
        rr = r * i / steps
        a = int(strength * (1 - i / steps) ** 1.6)
        gd.ellipse([cx - rr, cy - rr * 0.7, cx + rr, cy + rr * 0.7], fill=color + (a,))
    img.alpha_composite(glow)

def scanlines(img, gap=3, alpha=10):
    W, H = img.size
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    for y in range(0, H, gap):
        od.line([(0, y), (W, y)], fill=(255, 255, 255, alpha))
    img.alpha_composite(ov)

def vignette(img, strength=150):
    W, H = img.size
    s = 90
    mask = Image.new('L', (s, s), 0)
    pxm = mask.load()
    cx, cy = s/2, s/2
    maxd = (cx*cx + cy*cy) ** 0.5
    for yy in range(s):
        for xx in range(s):
            dist = ((xx-cx)**2 + (yy-cy)**2) ** 0.5 / maxd
            pxm[xx, yy] = int(min(255, strength * dist ** 2.4))
    mask = mask.resize((W, H))
    black = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    clear = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    img.alpha_composite(Image.composite(black, clear, mask))

def boxhead(d, cx, base, s, alpha=255, tone=1.0):
    """画一个方块头僵尸（仿游戏 drawZombie 的正面剪影）。base 为脚底 y。"""
    def col(c):
        return tuple(int(v * tone) for v in c) + (alpha,)
    out = (INK[0], INK[1], INK[2], alpha)
    # 影子
    d.ellipse([cx - s*0.9, base - s*0.18, cx + s*0.9, base + s*0.18], fill=(0, 0, 0, int(60*alpha/255)))
    # 腿
    d.rectangle([cx - s*0.55, base - s*0.55, cx - s*0.15, base], fill=col((40, 38, 36)))
    d.rectangle([cx + s*0.15, base - s*0.55, cx + s*0.55, base], fill=col((40, 38, 36)))
    # 身体（白衣）
    by1 = base - s*1.45
    d.rectangle([cx - s*0.7, by1, cx + s*0.7, base - s*0.45], fill=col(ZBODY), outline=out, width=max(1, s//22))
    # V 领
    d.polygon([(cx - s*0.42, by1), (cx + s*0.42, by1), (cx, by1 + s*0.55)], fill=col(ZVNECK))
    # 双臂前伸
    d.rectangle([cx - s*0.95, by1 + s*0.18, cx + s*0.95, by1 + s*0.5], fill=col(ZBODY), outline=out, width=max(1, s//26))
    # 黑方块头
    hh = s*1.5
    d.rectangle([cx - s*0.7, by1 - hh, cx + s*0.7, by1 + s*0.05], fill=out, outline=out)
    # 顶部反光
    d.rectangle([cx - s*0.7, by1 - hh, cx + s*0.7, by1 - hh + s*0.16],
                fill=(255, 255, 255, int(20*alpha/255)))

def seg_title(img, parts, cx, cy, fnt, shadow_layers=((4, RED_DK1), (8, RED_DK2))):
    """居中绘制分色标题 parts=[(text,color),...]，带分层投影。"""
    d = ImageDraw.Draw(img)
    widths = [d.textbbox((0, 0), t, font=fnt)[2] for t, _ in parts]
    total = sum(widths)
    asc, desc = fnt.getmetrics()
    x = cx - total / 2
    y = cy - (asc + desc) / 2
    for dy, col in shadow_layers:
        xx = x
        for (t, _), w in zip(parts, widths):
            d.text((xx, y + dy), t, font=fnt, fill=col)
            xx += w
    xx = x
    for (t, col), w in zip(parts, widths):
        d.text((xx, y), t, font=fnt, fill=col)
        xx += w

def badges(img, items, cx, cy, fnt):
    d = ImageDraw.Draw(img)
    pads, gap = 22, 16
    sizes = [d.textbbox((0, 0), t, font=fnt)[2] + pads*2 for t in items]
    total = sum(sizes) + gap*(len(items)-1)
    x = cx - total/2
    asc, desc = fnt.getmetrics()
    h = asc + desc + 14
    for t, w in zip(items, sizes):
        d.rounded_rectangle([x, cy, x+w, cy+h], radius=8, fill=(38, 34, 26, 200), outline=(87, 80, 63, 255), width=2)
        d.text((x + (w - d.textbbox((0,0), t, font=fnt)[2])/2, cy + 7), t, font=fnt, fill=CREAM)
        x += w + gap

# ============ logo.png（封面 1280x720）============
def make_cover():
    W, H = 1280, 720
    img = gradient_bg(W, H).convert('RGBA')
    add_glow(img, W//2, int(H*0.30), 620, RED, 60)
    add_glow(img, int(W*0.16), int(H*0.85), 380, GREEN, 14)
    # 背景僵尸群（暗、半透明）
    crowd = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crowd)
    for cx, sc, al, tn in [(150, 70, 120, .8), (1130, 78, 120, .8), (300, 52, 90, .7),
                            (980, 50, 90, .7), (640, 60, 70, .7)]:
        boxhead(cd, cx, int(H*0.96), sc, alpha=al, tone=tn)
    img.alpha_composite(crowd)
    # 前景两只清晰僵尸
    fg = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    boxhead(fd, 235, int(H*0.99), 96)
    boxhead(fd, 1045, int(H*0.99), 96)
    img.alpha_composite(fg)
    scanlines(img)
    seg_title(img, [('僵尸', CREAM), ('危机', RED)], W//2, int(H*0.30), font(168),
              shadow_layers=((5, RED_DK1), (10, RED_DK2), (16, (0,0,0))))
    d = ImageDraw.Draw(img)
    sub = '方 块 头 · 经 典 复 刻 版'
    sf = font(40)
    d.text(((W - d.textbbox((0,0), sub, font=sf)[2])/2, int(H*0.46)), sub, font=sf, fill=(156, 148, 127))
    badges(img, ['9 种武器', '5 张地图', '5 级BOSS', '无双大招'], W//2, int(H*0.57), font(26))
    vignette(img, 160)
    img.convert('RGB').save(os.path.join(OUT, 'logo.png'))
    print('written images/logo.png', W, 'x', H)

# ============ banner.jpg（横幅 1920x640）============
def make_banner():
    W, H = 1920, 640
    img = gradient_bg(W, H).convert('RGBA')
    add_glow(img, int(W*0.32), int(H*0.5), 720, RED, 55)
    crowd = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crowd)
    for cx, sc, al, tn in [(1500, 120, 150, .85), (1700, 95, 120, .8), (1330, 80, 100, .75),
                            (1600, 60, 80, .7), (1180, 64, 70, .7)]:
        boxhead(cd, cx, int(H*1.02), sc, alpha=al, tone=tn)
    img.alpha_composite(crowd)
    scanlines(img)
    # 左对齐标题
    d = ImageDraw.Draw(img)
    fnt = font(150)
    asc, desc = fnt.getmetrics()
    x0, y = 120, int(H*0.5) - (asc+desc)/2
    for dy, col in ((6, RED_DK1), (12, RED_DK2), (18, (0,0,0))):
        d.text((x0, y+dy), '僵尸', font=fnt, fill=col)
        w1 = d.textbbox((0,0), '僵尸', font=fnt)[2]
        d.text((x0+w1, y+dy), '危机', font=fnt, fill=col)
    w1 = d.textbbox((0,0), '僵尸', font=fnt)[2]
    d.text((x0, y), '僵尸', font=fnt, fill=CREAM)
    d.text((x0+w1, y), '危机', font=fnt, fill=RED)
    sf = font(38)
    d.text((x0+6, y + asc + desc + 6), '方块头 · 经典复刻版　|　俯视角波次射击', font=sf, fill=(180, 172, 150))
    vignette(img, 150)
    img.convert('RGB').save(os.path.join(OUT, 'banner.jpg'), quality=90)
    print('written images/banner.jpg', W, 'x', H)

# ============ poster.png（平台封面 1200x900，4:3）============
# Toy 列表卡片与公开动态卡片按 4:3 取图，3:1 的 banner 放进卡片会被裁掉两头。
# 公开发布的 Toy 用这张。
def make_poster():
    W, H = 1200, 900
    img = gradient_bg(W, H).convert('RGBA')
    add_glow(img, W//2, int(H*0.26), 620, RED, 62)
    add_glow(img, int(W*0.14), int(H*0.88), 360, GREEN, 15)
    # 三层僵尸群：4:3 竖向空间更多，堆密一点，别在文案与尸群之间留一条空带
    crowd = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crowd)
    for cx, sc, al, tn in [(70, 66, 78, .6), (250, 60, 66, .55), (450, 56, 56, .5),
                           (760, 58, 58, .5), (960, 64, 70, .58), (1140, 68, 78, .6)]:
        boxhead(cd, cx, int(H*0.90), sc, alpha=al, tone=tn)
    img.alpha_composite(crowd)
    mid = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    md = ImageDraw.Draw(mid)
    for cx, sc, al, tn in [(150, 96, 150, .8), (520, 92, 132, .76),
                           (690, 94, 132, .76), (1050, 100, 150, .8)]:
        boxhead(md, cx, int(H*0.96), sc, alpha=al, tone=tn)
    img.alpha_composite(mid)
    fg = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    boxhead(fd, 300, int(H*1.02), 128)
    boxhead(fd, 900, int(H*1.02), 128)
    img.alpha_composite(fg)
    scanlines(img)
    seg_title(img, [('僵尸', CREAM), ('危机', RED)], W//2, int(H*0.255), font(160),
              shadow_layers=((5, RED_DK1), (10, RED_DK2), (16, (0, 0, 0))))
    d = ImageDraw.Draw(img)
    sub = '方 块 头 · 经 典 复 刻 版'
    sf = font(38)
    d.text(((W - d.textbbox((0, 0), sub, font=sf)[2])/2, int(H*0.375)), sub, font=sf, fill=(156, 148, 127))
    badges(img, ['9 种武器', '5 张地图', '5 级BOSS', '排行榜'], W//2, int(H*0.455), font(26))
    tip = '俯视角波次射击　|　手机竖屏也能玩'
    tf = font(24, bold=False)
    d.text(((W - d.textbbox((0, 0), tip, font=tf)[2])/2, int(H*0.545)), tip, font=tf, fill=(124, 118, 101))
    vignette(img, 165)
    img.convert('RGB').save(os.path.join(OUT, 'poster.png'))
    print('written images/poster.png', W, 'x', H)

if __name__ == '__main__':
    make_cover()
    make_banner()
    make_poster()
