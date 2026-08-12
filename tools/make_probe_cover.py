# -*- coding: utf-8 -*-
"""生成内部测试 Toy「WebRTC 热点直连探针」的 4:3 封面 tools/probe-poster.png。

刻意不复用游戏那套血红丧尸配色：这是张诊断页，不是游戏，列表里也该一眼看出来不是。
配色直接取 webrtc-probe.html 的 CSS 变量。重新生成： python tools/make_probe_cover.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, 'probe-poster.png')

W, H = 1200, 900          # Toy 列表卡片按 4:3 取图

# ---- 配色：与 webrtc-probe.html 的 :root 一致 ----
BG_TOP = (24, 28, 36)
BG_BOT = (13, 16, 22)
LINE   = (43, 51, 64)
FG     = (230, 235, 242)
DIM    = (141, 153, 171)
KEY    = (121, 215, 255)     # --key 青
OK     = (121, 227, 159)     # --ok  绿


def font(size, bold=True):
    for name in (('msyhbd.ttc', 'msyh.ttc') if bold else ('msyh.ttc',)):
        p = os.path.join(r'C:\Windows\Fonts', name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg():
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        c = lerp(BG_TOP, BG_BOT, y / (H - 1))
        for x in range(W):
            px[x, y] = c
    return img.convert('RGBA')


def grid(img, step=60, alpha=16):
    """淡网格：诊断仪表的底子，不抢主体"""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=LINE + (alpha,), width=1)
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=LINE + (alpha,), width=1)
    img.alpha_composite(layer)


def glow(img, cx, cy, r, color, strength=90):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 24
    for i in range(steps, 0, -1):
        rr = r * i / steps
        a = int(strength * (1 - i / steps) ** 1.7)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=color + (a,))
    img.alpha_composite(layer)


def device(d, cx, cy, w=118, h=196, accent=KEY):
    """一台手机：圆角机身 + 亮色屏幕，两台并排就是 P2P 的全部叙事"""
    d.rounded_rectangle([cx - w/2, cy - h/2, cx + w/2, cy + h/2], radius=20,
                        fill=(27, 32, 42), outline=accent, width=4)
    d.rounded_rectangle([cx - w/2 + 14, cy - h/2 + 22, cx + w/2 - 14, cy + h/2 - 22],
                        radius=8, fill=(13, 16, 22))
    d.rounded_rectangle([cx - 18, cy - h/2 + 10, cx + 18, cy - h/2 + 16], radius=3, fill=LINE)


def main():
    img = gradient_bg()
    grid(img)

    cy = int(H * 0.40)
    lx, rx = int(W * 0.28), int(W * 0.72)

    # 两端各一团光，中间的连线是这张图唯一的主角
    glow(img, lx, cy, 240, KEY, 70)
    glow(img, rx, cy, 240, OK, 70)

    d = ImageDraw.Draw(img)

    # 连线：虚线画成一串方点，暗示分组传输
    seg, gap, r = 16, 14, 5
    x = lx + 80
    while x < rx - 80:
        t = (x - lx) / (rx - lx)
        d.ellipse([x, cy - r, x + r * 2, cy + r], fill=lerp(KEY, OK, t))
        x += seg + gap

    device(d, lx, cy, accent=KEY)
    device(d, rx, cy, accent=OK)

    # 连线中点压一个 P2P 标签，防止中间那段读成装饰
    tag, tf = 'P2P', font(30)
    tw = d.textbbox((0, 0), tag, font=tf)[2]
    bw, bh = tw + 44, 54
    bx, by = (lx + rx) / 2 - bw / 2, cy - bh / 2
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=27, fill=(13, 16, 22), outline=LINE, width=2)
    d.text((bx + 22, by + 9), tag, font=tf, fill=DIM)

    # 标题
    title, ft = '热点直连探针', font(96)
    tw = d.textbbox((0, 0), title, font=ft)[2]
    d.text(((W - tw) / 2, int(H * 0.60)), title, font=ft, fill=FG)

    sub, fs = 'WebRTC 局域网可行性验证', font(38)
    sw = d.textbbox((0, 0), sub, font=fs)[2]
    d.text(((W - sw) / 2, int(H * 0.775)), sub, font=fs, fill=DIM)

    # 明确标注不是游戏，免得混进作品列表被误点
    note, fn = '内部测试 · 非游戏', font(30)
    nw = d.textbbox((0, 0), note, font=fn)[2]
    bw, bh = nw + 40, 52
    bx, by = (W - bw) / 2, int(H * 0.875)
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=26, fill=(27, 32, 42), outline=LINE, width=2)
    d.text((bx + 20, by + 9), note, font=fn, fill=DIM)

    img.convert('RGB').save(OUT, quality=95)
    print('wrote', OUT, img.size)


if __name__ == '__main__':
    main()
