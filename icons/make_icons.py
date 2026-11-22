"""koma-duel のアプリアイコン（PNG）を生成する。Pillow が必要。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

SS = 4  # supersampling


def disc(draw, cx, cy, r, base, light, dark):
    # 落ち影
    draw.ellipse([cx - r * 1.02, cy - r * 1.02 + r * 0.14, cx + r * 1.02, cy + r * 1.02 + r * 0.14],
                 fill=(0, 0, 0, 110))
    # 外周から中心へ放射状グラデーション（光源は左上）
    steps = max(24, int(r))
    for k in range(steps, 0, -1):
        t = k / steps                     # 1=外周, 0=中心
        rr = r * t
        ox = cx - r * 0.24 * (1 - t)
        oy = cy - r * 0.28 * (1 - t)
        f = (1 - t) ** 0.75
        col = tuple(int(dark[i] + (light[i] - dark[i]) * f) for i in range(3))
        draw.ellipse([ox - rr, oy - rr, ox + rr, oy + rr], fill=col)
    # 縁のリング
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(0, 0, 0, 40), width=max(1, int(r * 0.03)))
    # つや（左上の小さな反射）
    hr = r * 0.26
    hx, hy = cx - r * 0.34, cy - r * 0.38
    draw.ellipse([hx - hr, hy - hr * 0.72, hx + hr, hy + hr * 0.72], fill=(255, 255, 255, 46))


def make(size, maskable=False):
    W = size * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")

    pad = int(W * (0.16 if maskable else 0.10))
    radius = int(W * 0.22)
    # 背景（角丸の暗い板）
    d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=radius, fill=(17, 20, 28, 255))
    if not maskable:
        d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=radius,
                            outline=(255, 255, 255, 26), width=max(1, W // 220))

    # 中央に積まれた3枚（大=金、中=青、小=金）
    cx = W // 2
    base_y = int(W * 0.66)
    gold_l = (255, 226, 138); gold_d = (150, 88, 8)
    blue_l = (206, 230, 255); blue_d = (22, 66, 146)

    disc(d, cx, base_y, int(W * (0.24 if maskable else 0.26)), (0, 0, 0), gold_l, gold_d)
    disc(d, cx, base_y - int(W * (0.115 if maskable else 0.125)),
         int(W * (0.175 if maskable else 0.19)), (0, 0, 0), blue_l, blue_d)
    disc(d, cx, base_y - int(W * (0.205 if maskable else 0.225)),
         int(W * (0.115 if maskable else 0.125)), (0, 0, 0), gold_l, gold_d)

    return img.resize((size, size), Image.LANCZOS)


for s in (192, 512):
    make(s).save(os.path.join(OUT, f"icon-{s}.png"))
make(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
make(180).save(os.path.join(OUT, "apple-touch-icon.png"))
make(32).save(os.path.join(OUT, "favicon-32.png"))

svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="51" y="51" width="410" height="410" rx="112" fill="#11141c" stroke="#ffffff" stroke-opacity="0.10"/>
  <defs>
    <radialGradient id="g" cx="34%" cy="26%" r="78%">
      <stop offset="0" stop-color="#fff4cf"/><stop offset="0.3" stop-color="#f9d372"/>
      <stop offset="0.62" stop-color="#e6a52a"/><stop offset="1" stop-color="#96600c"/>
    </radialGradient>
    <radialGradient id="b" cx="34%" cy="26%" r="78%">
      <stop offset="0" stop-color="#eaf3ff"/><stop offset="0.3" stop-color="#9cc8ff"/>
      <stop offset="0.62" stop-color="#4f8ade"/><stop offset="1" stop-color="#1b468a"/>
    </radialGradient>
  </defs>
  <circle cx="256" cy="338" r="133" fill="url(#g)"/>
  <circle cx="256" cy="274" r="97" fill="url(#b)"/>
  <circle cx="256" cy="223" r="64" fill="url(#g)"/>
</svg>
"""
with open(os.path.join(OUT, "favicon.svg"), "w", encoding="utf-8") as f:
    f.write(svg)

print("icons:", sorted(os.listdir(OUT)))
