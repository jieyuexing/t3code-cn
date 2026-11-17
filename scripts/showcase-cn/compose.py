#!/usr/bin/env python3
"""把 record.ts 的关键帧合成推特展示视频：渐变底、圆角窗口、推近镜头、光标移动、点击波纹、交叉淡入。

用法：python3 -I compose.py <关键帧目录>，产出同目录下 showcase.mp4 与 cover.png。依赖 Pillow 与 ffmpeg。
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

FPS, OW, OH = 30, 1920, 1080
MOVE, FADE, RIPPLE = 0.8, 0.3, 0.45

src = Path(sys.argv[1])
meta = json.loads((src / "beats.json").read_text())
beats, k = meta["beats"], meta["scale"]
frames = [Image.open(src / b["file"]).convert("RGB") for b in beats]
W, H = frames[0].size
MAX_SECONDS, MIN_CHANGED = 50, 0.001


def changed_ratio(a, b):
    """两张关键帧里明显不同的像素占比：一拍点了却没有变化，说明点空了。"""
    diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    return sum(diff.histogram()[255:]) / (W * H)


for i in range(1, len(frames)):
    ratio = changed_ratio(frames[i - 1], frames[i])
    if ratio < MIN_CHANGED:
        sys.exit(f"关键帧 {beats[i]['label']} 与上一帧几乎没有区别（{ratio:.4%}），这一拍没有产生可见变化")
PY = 160
SH = H + 2 * PY
SW = round(SH * 16 / 9)
PX = (SW - W) // 2
R = 36


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def stage_bg():
    c1, c2 = ((30, 27, 75), (59, 7, 100)) if meta.get("dark") else ((199, 210, 254), (233, 213, 255))
    g = Image.new("RGB", (160, 90))
    g.putdata([tuple(round(a + (b - a) * (x / 159 * 0.6 + y / 89 * 0.4)) for a, b in zip(c1, c2))
               for y in range(90) for x in range(160)])
    bg = g.resize((SW, SH), Image.BICUBIC).convert("RGBA")
    shadow = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((PX, PY + 24, PX + W, PY + H + 24), radius=R, fill=(30, 27, 75, 90))
    return Image.alpha_composite(bg, shadow.filter(ImageFilter.GaussianBlur(48))).convert("RGB")


BG = stage_bg()
MASK = Image.new("L", (W, H), 0)
ImageDraw.Draw(MASK).rounded_rectangle((0, 0, W - 1, H - 1), radius=R, fill=255)
FULL = (SW / 2, SH / 2, SW)


def camera(beat):
    z = beat["zoom"]
    if not z:
        return FULL
    w = min(z["w"] * k, SW)
    h = w * 9 / 16
    cx = min(max(PX + (z["x"] + z["w"] / 2) * k, w / 2), SW - w / 2)
    cy = min(max(PY + (z["y"] * k) + h / 2 - 40, h / 2), SH - h / 2)
    return (cx, cy, w)


def center(beat):
    t = beat["target"]
    return (PX + (t["x"] + t["w"] / 2) * k, PY + (t["y"] + t["h"] / 2) * k)


def cursor_sprite(size=56, ss=4):
    """抗锯齿的箭头光标：白描边黑芯带柔和投影，尖端在 (pad, pad)。"""
    pts = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12.5), (12.5, 12.5)]
    unit, pad = size * ss / 20, 6 * ss
    shape = [(pad + x * unit, pad + y * unit) for x, y in pts]
    big = Image.new("RGBA", (size * ss + 2 * pad, size * ss + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("RGBA", big.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 2 * ss, y + 4 * ss) for x, y in shape], fill=(0, 0, 0, 90))
    big = Image.alpha_composite(big, shadow.filter(ImageFilter.GaussianBlur(3 * ss)))
    d = ImageDraw.Draw(big)
    d.polygon(shape, fill=(255, 255, 255, 255))
    cx, cy = sum(x for x, _ in shape) / len(shape), sum(y for _, y in shape) / len(shape)
    inner = [(cx + (x - cx) * 0.78, cy + (y - cy) * 0.78) for x, y in shape]
    off = (shape[0][0] - inner[0][0] + 1.6 * ss, shape[0][1] - inner[0][1] + 2.4 * ss)
    d.polygon([(x + off[0], y + off[1]) for x, y in inner], fill=(18, 18, 18, 255))
    return big.resize((big.width // ss, big.height // ss), Image.LANCZOS), pad // ss


CURSOR, CURSOR_TIP = cursor_sprite()
CURSOR_PRESSED = CURSOR.resize((round(CURSOR.width * 0.86), round(CURSOR.height * 0.86)), Image.LANCZOS)


# 时间线：每一拍先移光标并推镜头，到点后点击、淡入新画面，再停留。
timeline = []
t = 0.0
cam, pos = FULL, (PX + W * 0.55, PY + H * 0.75)
for i, beat in enumerate(beats):
    if i == 0:
        timeline.append(dict(t0=0, t1=beat["hold"], cam0=cam, cam1=cam, pos0=pos, pos1=pos, frm=0, prev=0, click=None, ripple=False))
        t = beat["hold"]
        continue
    new_cam = camera(beat)
    new_pos = center(beat) if beat["target"] else pos
    move = MOVE if beat["target"] else 0.0
    dur = move + max(FADE, 0.5) + beat["hold"]
    timeline.append(dict(t0=t, t1=t + dur, cam0=cam, cam1=new_cam, pos0=pos, pos1=new_pos, frm=i, prev=i - 1,
                         click=t + move, ripple=bool(beat["target"])))
    cam, pos, t = new_cam, new_pos, t + dur
TOTAL = t
if TOTAL > MAX_SECONDS:
    sys.exit(f"视频 {TOTAL:.1f} 秒，超过 {MAX_SECONDS} 秒上限，压缩各拍的 hold")


def render(now):
    seg = next(s for s in timeline if now <= s["t1"]) if now < TOTAL else timeline[-1]
    click = seg["click"]
    cam_t = ease((now - seg["t0"]) / max(MOVE + 0.5, 0.01))
    cx, cy, cw = lerp(seg["cam0"], seg["cam1"], cam_t)
    move_end = click if click is not None else seg["t0"]
    px, py = lerp(seg["pos0"], seg["pos1"], ease((now - seg["t0"]) / max(move_end - seg["t0"], 0.01)))
    fade = 1.0 if click is None else ease((now - click) / FADE)
    win = frames[seg["frm"]] if fade >= 1 else Image.blend(frames[seg["prev"]], frames[seg["frm"]], fade)
    img = BG.copy()
    img.paste(win, (PX, PY), MASK)
    d = ImageDraw.Draw(img, "RGBA")
    if seg["ripple"] and 0 <= now - click <= RIPPLE:
        p = (now - click) / RIPPLE
        r = 18 + 70 * ease(p)
        d.ellipse((px - r, py - r, px + r, py + r), outline=(99, 102, 241, int(220 * (1 - p))), width=6)
    if seg["frm"] > 0 or now > timeline[0]["t1"] * 0.5:
        pressed = seg["ripple"] and 0 <= now - click <= 0.15
        sprite = CURSOR_PRESSED if pressed else CURSOR
        tip = CURSOR_TIP * (0.86 if pressed else 1)
        img.paste(sprite, (round(px - tip), round(py - tip)), sprite)
    ch = cw * 9 / 16
    return img.transform((OW, OH), Image.EXTENT, (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2), Image.BICUBIC)


out = src / "showcase.mp4"
ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OW}x{OH}",
                       "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                       "-preset", "slow", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
for f in range(int(TOTAL * FPS)):
    ff.stdin.write(render(f / FPS).tobytes())
ff.stdin.close()
ff.wait()

cover = BG.copy()
cover.paste(frames[-1], (PX, PY), MASK)
cover.save(src / "cover.png")
print(f"{out}（{TOTAL:.1f}s）与 {src / 'cover.png'}")
