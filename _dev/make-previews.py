#!/usr/bin/env python3
"""Generate faithful 960x400 preview.jpg images for the typographic widget set.

These are representative renders (not in-WebKit screenshots) used by the widget
picker; the installed bundle is the source of truth. Rendered at 2x supersample
then downscaled for crisp anti-aliasing.
"""
import base64
import io
import json
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SS = 2                      # supersample factor
W, H = 960, 400             # final preview size (2.4 aspect, matches existing)
SF = "/System/Library/Fonts/SFNS.ttf"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)  # SampleWidgets/


def font(size, heavy=False):
    f = ImageFont.truetype(SF, int(size * SS))
    return f


def W_(x):
    return int(x * SS)


def rgb(*c):
    return tuple(c)


def rounded_panel(base, box, radius, fill, shadow=True):
    """Draw a rounded panel with a soft drop shadow onto `base`."""
    x0, y0, x1, y1 = [W_(v) for v in box]
    r = W_(radius)
    if shadow:
        sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.rounded_rectangle([x0, y0 + W_(8), x1, y1 + W_(8)], r, fill=(0, 0, 0, 150))
        sh = sh.filter(ImageFilter.GaussianBlur(W_(18)))
        base.alpha_composite(sh)
    d = ImageDraw.Draw(base)
    d.rounded_rectangle([x0, y0, x1, y1], r, fill=fill)


def text(d, xy, s, f, fill, heavy=False, anchor="la"):
    x, y = W_(xy[0]), W_(xy[1])
    sw = W_(0.7) if heavy else 0
    d.text((x, y), s, font=f, fill=fill, anchor=anchor,
           stroke_width=sw, stroke_fill=fill)


def textw(d, s, f):
    return d.textlength(s, font=f) / SS


def backdrop(accent, dark=True):
    """Soft diagonal gradient backdrop tinted slightly by the accent."""
    base = Image.new("RGBA", (W_(W), W_(H)), (0, 0, 0, 255))
    top = (26, 26, 32) if dark else (228, 228, 234)
    bot = (12, 12, 16) if dark else (208, 208, 216)
    g = Image.new("RGBA", (1, H), (0, 0, 0, 255))
    for y in range(H):
        t = y / H
        r = int(top[0] * (1 - t) + bot[0] * t)
        gg = int(top[1] * (1 - t) + bot[1] * t)
        b = int(top[2] * (1 - t) + bot[2] * t)
        g.putpixel((0, y), (r, gg, b, 255))
    g = g.resize((W_(W), W_(H)))
    base.alpha_composite(g)
    # faint accent glow, top-left
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W_(-120), W_(-160), W_(360), W_(220)], fill=accent + (40,))
    glow = glow.filter(ImageFilter.GaussianBlur(W_(60)))
    base.alpha_composite(glow)
    return base


def transport(d, cx, cy, color, size=11, gap=30):
    """Draw prev / play / next glyphs centered around (cx,cy), faint.

    `gap` is the centre-to-centre spacing; V3 passes its real control pitch so its two
    rows line up with each other, the rest keep the original hardcoded 30.
    """
    s = size
    # prev: bar + triangle
    px = cx - gap
    d.rectangle([W_(px - s * 0.7), W_(cy - s * 0.55), W_(px - s * 0.5), W_(cy + s * 0.55)], fill=color)
    d.polygon([(W_(px + s * 0.6), W_(cy - s * 0.55)), (W_(px + s * 0.6), W_(cy + s * 0.55)),
               (W_(px - s * 0.35), W_(cy))], fill=color)
    # play: triangle
    d.polygon([(W_(cx - s * 0.5), W_(cy - s * 0.7)), (W_(cx - s * 0.5), W_(cy + s * 0.7)),
               (W_(cx + s * 0.7), W_(cy))], fill=color)
    # next: triangle + bar
    nx = cx + gap
    d.polygon([(W_(nx - s * 0.6), W_(cy - s * 0.55)), (W_(nx - s * 0.6), W_(cy + s * 0.55)),
               (W_(nx + s * 0.35), W_(cy))], fill=color)
    d.rectangle([W_(nx + s * 0.5), W_(cy - s * 0.55), W_(nx + s * 0.7), W_(cy + s * 0.55)], fill=color)


_SF_CACHE = None


def _sf_cache():
    """The real SF Symbols, rendered by make-symbol-cache.swift."""
    global _SF_CACHE
    if _SF_CACHE is None:
        with open(os.path.join(HERE, "sfsymbols-cache.json")) as f:
            _SF_CACHE = json.load(f)
    return _SF_CACHE


def sf(base, name, cx, cy, pt, color):
    """Composite a real SF Symbol, tinted, centred on (cx, cy) at `pt` points.

    The hand-drawn `transport`/`heart` helpers predate this and stay for the previews that
    already use them. Prefer this one: an approximated icon in a picker preview is a
    promise the widget does not keep.
    """
    cache = _sf_cache()
    if name not in cache:
        raise KeyError("%s missing from sfsymbols-cache.json — add it to "
                       "make-symbol-cache.swift and re-run that first" % name)
    raw = base64.b64decode(cache[name].split(",", 1)[1])
    # The cached template is white, square and aspect-fit, exactly like the PNG the
    # native bridge hands a widget — so a square paste box is correct here too.
    glyph = Image.open(io.BytesIO(raw)).convert("RGBA")
    px = max(1, W_(pt))
    glyph = glyph.resize((px, px), Image.LANCZOS)
    alpha = glyph.split()[3]
    if len(color) > 3 and color[3] < 255:
        alpha = alpha.point(lambda a, m=color[3]: a * m // 255)
    tinted = Image.new("RGBA", glyph.size, tuple(color[:3]) + (0,))
    tinted.putalpha(alpha)
    base.alpha_composite(tinted, (W_(cx) - px // 2, W_(cy) - px // 2))


def heart(d, cx, cy, s, color):
    r = s / 2
    d.ellipse([W_(cx - s / 2), W_(cy - r / 2), W_(cx), W_(cy + r / 2)], fill=color)
    d.ellipse([W_(cx), W_(cy - r / 2), W_(cx + s / 2), W_(cy + r / 2)], fill=color)
    d.polygon([(W_(cx - s / 2 + 1), W_(cy + r / 4)), (W_(cx + s / 2 - 1), W_(cy + r / 4)),
               (W_(cx), W_(cy + s * 0.7))], fill=color)


def save(img, name):
    out = img.resize((W, H), Image.LANCZOS).convert("RGB")
    path = os.path.join(OUT, name + ".nepget", "preview.jpg")
    out.save(path, "JPEG", quality=88)
    print("wrote", path)


# ---------------------------------------------------------------- Headline
def headline():
    accent = rgb(232, 74, 96)  # from a warm/red cover
    base = backdrop(accent)
    rounded_panel(base, (180, 70, 780, 330), 22, (11, 11, 13, 255))
    d = ImageDraw.Draw(base)
    text(d, (212, 110), "Honey", font(74), (245, 245, 247), heavy=True)
    text(d, (214, 200), "Robyn · Honey", font(17), (245, 245, 247, 140))
    # hairline progress
    d.rounded_rectangle([W_(214), W_(244), W_(746), W_(247)], W_(2), fill=(255, 255, 255, 36))
    d.rounded_rectangle([W_(214), W_(244), W_(214 + 300), W_(247)], W_(2), fill=accent)
    d.ellipse([W_(214 + 300 - 4), W_(241), W_(214 + 300 + 4), W_(250)], fill=accent)
    text(d, (214, 262), "1:24", font(12), (245, 245, 247, 130))
    text(d, (746, 262), "-1:46", font(12), accent, anchor="ra")
    transport(d, 660, 300, (245, 245, 247, 150), size=12)
    heart(d, 735, 300, 18, accent)
    save(base, "Headline")


# ------------------------------------------------------------------- Strip
def strip():
    accent = rgb(168, 116, 255)  # purple cover
    base = backdrop(accent)
    rounded_panel(base, (150, 168, 810, 232), 18, (20, 20, 23, 240))
    d = ImageDraw.Draw(base)
    # play glyph (accent)
    d.polygon([(W_(178), W_(190)), (W_(178), W_(210)), (W_(196), W_(200))], fill=accent)
    text(d, (214, 188), "Robyn — Honey", font(17), (245, 245, 247, 245))
    text(d, (784, 188), "1:24", font(13), (245, 245, 247, 150), anchor="ra")
    # underline progress
    d.rounded_rectangle([W_(150), W_(229), W_(150 + 264), W_(232)], W_(2), fill=accent)
    text(d, (480, 300), "a slim ticker for any screen edge", font(13), (235, 235, 240, 120), anchor="ma")
    save(base, "Strip")


# ------------------------------------------------------------------ Charts
def charts():
    accent = rgb(60, 122, 232)  # blue cover
    base = backdrop(accent)
    rounded_panel(base, (250, 44, 710, 356), 22, (12, 12, 15, 255))
    d = ImageDraw.Draw(base)
    text(d, (284, 78), "TOP ALBUMS", font(15), (245, 245, 247, 230), heavy=True)
    text(d, (676, 80), "7 DAYS", font(12), (245, 245, 247, 110), anchor="ra")
    d.rectangle([W_(284), W_(108), W_(676), W_(109)], fill=accent + (120,))
    rows = [("01", "Body Talk", "Robyn", "142"),
            ("02", "Currents", "Tame Impala", "118"),
            ("03", "Blue", "Joni Mitchell", "97"),
            ("04", "Mezzanine", "Massive Attack", "76"),
            ("05", "Swim", "Caribou", "61")]
    y = 126
    for rank, name, by, plays in rows:
        text(d, (284, y), rank, font(22), accent, heavy=True)
        text(d, (330, y + 1), name, font(16), (240, 240, 244))
        text(d, (330, y + 24), by, font(11), (240, 240, 244, 110))
        text(d, (676, y + 6), plays + " plays", font(12), (240, 240, 244, 120), anchor="ra")
        y += 46
    save(base, "Charts")


# --------------------------------------------------------------- Scrobbles
def scrobbles():
    accent = rgb(46, 196, 126)  # green cover
    base = backdrop(accent)
    rounded_panel(base, (250, 36, 710, 364), 22, (12, 12, 15, 255))
    d = ImageDraw.Draw(base)
    text(d, (284, 64), "48,213", font(58), (244, 250, 246), heavy=True)
    text(d, (288, 138), "scrobbles", font(15), (240, 240, 244, 120))
    d.rectangle([W_(284), W_(174), W_(676), W_(175)], fill=(255, 255, 255, 22))
    rows = [(True, "Honey", "Robyn", "now"),
            (False, "Borderline", "Tame Impala", "9m"),
            (False, "A Case of You", "Joni Mitchell", "18m"),
            (False, "Teardrop", "Massive Attack", "27m")]
    y = 192
    for now, name, by, when in rows:
        if now:
            d.ellipse([W_(286), W_(y + 7), W_(296), W_(y + 17)], fill=accent)
        nx = 308 if now else 286
        col = accent if now else (240, 240, 244)
        text(d, (nx, y), name, font(16), col)
        text(d, (nx, y + 22), by, font(11), (240, 240, 244, 110))
        wcol = accent if now else (240, 240, 244, 120)
        text(d, (676, y + 6), when, font(12), wcol, anchor="ra")
        y += 42
    save(base, "Scrobbles")



# ---------------------------------------------------- artwork-cover helpers
def _vgrad(size, c1, c2):
    w, h = size
    col = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        col.putpixel((0, y), tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    return col.resize((w, h))


def art_cover(base, box, radius, c1, c2):
    """Rounded 'album cover': layered (Vinyl-style) drop shadow + gradient fill + sheen."""
    x0, y0, x1, y1 = [W_(v) for v in box]
    r = W_(radius)
    w, h = x1 - x0, y1 - y0
    for dy, blur, alpha in [(W_(3), W_(9), 72), (W_(11), W_(26), 52)]:
        sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + dy, x1, y1 + dy], r, fill=(0, 0, 0, alpha))
        base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    cover = _vgrad((w, h), c1, c2).convert("RGBA")
    sheen = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse([-w // 4, -h // 3, int(w * 0.85), int(h * 0.55)], fill=(255, 255, 255, 26))
    cover = Image.alpha_composite(cover, sheen.filter(ImageFilter.GaussianBlur(W_(22))))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], r, fill=255)
    base.paste(cover, (x0, y0), mask)


def play_circle(base, cx, cy, r, bg, ink):
    d = ImageDraw.Draw(base)
    d.ellipse([W_(cx - r), W_(cy - r), W_(cx + r), W_(cy + r)], fill=bg)
    s = r * 0.5
    d.polygon([(W_(cx - s * 0.5), W_(cy - s * 0.85)), (W_(cx - s * 0.5), W_(cy + s * 0.85)),
               (W_(cx + s * 0.95), W_(cy))], fill=ink)


# -------------------------------------------------------------------- Glass
def glass():
    accent = rgb(120, 130, 205)
    base = backdrop(accent)
    art_cover(base, (330, 46, 630, 346), 20, (98, 122, 178), (34, 44, 80))
    panel = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(panel).rounded_rectangle([W_(350), W_(244), W_(610), W_(330)], W_(16), fill=(16, 16, 20, 150))
    base.alpha_composite(panel)
    d = ImageDraw.Draw(base)
    text(d, (480, 258), "Song Title", font(15), (245, 245, 247), heavy=True, anchor="ma")
    text(d, (480, 280), "Artist", font(12), (245, 245, 247, 185), anchor="ma")
    transport(d, 480, 312, (245, 245, 247, 205), size=11)
    play_circle(base, 480, 312, 13, (245, 245, 247, 235), (24, 24, 26, 255))
    save(base, "Glass")


# ------------------------------------------------------------------- Sleeve
def sleeve():
    accent = rgb(70, 165, 152)
    base = backdrop(accent)
    art_cover(base, (150, 128, 302, 280), 12, (54, 152, 140), (18, 54, 68))
    d = ImageDraw.Draw(base)
    text(d, (340, 150), "Song Title", font(21), (245, 245, 247), heavy=True)
    text(d, (340, 190), "Album", font(15), (245, 245, 247, 190))
    text(d, (340, 216), "Artist", font(15), (245, 245, 247, 190))
    save(base, "Sleeve")


# -------------------------------------------------------------------- Stack
def stack():
    accent = rgb(152, 92, 202)
    base = backdrop(accent)
    art_cover(base, (392, 40, 568, 216), 14, (130, 86, 190), (48, 24, 72))
    d = ImageDraw.Draw(base)
    transport(d, 480, 250, (245, 245, 247, 205), size=11)
    play_circle(base, 480, 250, 13, (245, 245, 247, 235), (24, 24, 26, 255))
    text(d, (480, 280), "Song Title", font(16), (245, 245, 247), heavy=True, anchor="ma")
    text(d, (480, 306), "Artist", font(13), (245, 245, 247, 185), anchor="ma")
    save(base, "Stack")


# ----------------------------------------------------------------------- V3
def _clip_to_cover(base, box, radius, layer):
    """Composite an RGBA `layer` (cover-sized) onto `base`, clipped to the cover's
    rounded rect — so a full-width bar can't spill past the rounded corners."""
    x0, y0, x1, y1 = [W_(v) for v in box]
    w, h = x1 - x0, y1 - y0
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], W_(radius), fill=255)
    merged = Image.alpha_composite(base.crop((x0, y0, x1, y1)), layer)
    base.paste(merged, (x0, y0), mask)


def v3():
    """Two states side by side — resting cover with its title bar, and the frosted
    hover overlay — because 'controls appear on hover' is the whole point of V3.

    Drawn at the widget's true size: a 200x200 window on the 960x400 card. Everything
    else is derived from S rather than eyeballed, so the 12pt radius, 28pt bar and
    34pt control row keep their real proportions against the cover.
    """
    accent = rgb(226, 128, 58)
    base = backdrop(accent)
    c1, c2 = (238, 150, 64), (146, 44, 100)

    WIN = 200                         # manifest defaultSize
    PAD = 20                          # body padding the drop shadow renders into
    COVER = WIN - 2 * PAD             # 160pt — the visible card, V1's Small
    S = 1.0                           # preview px per pt: true size
    side = COVER * S
    radius = 12 * S
    bar_h = 28 * S

    gap = 120
    top = (H - side) / 2
    lx = (W - (2 * side + gap)) / 2
    left = (lx, top, lx + side, top + side)
    rx = lx + side + gap
    right = (rx, top, rx + side, top + side)

    # ---- resting: cover + the 28pt frosted title bar
    art_cover(base, left, radius, c1, c2)
    x0, y0, x1, y1 = [W_(v) for v in left]
    bar = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rectangle([0, (y1 - y0) - W_(bar_h), x1 - x0, y1 - y0], fill=(0, 0, 0, 148))
    _clip_to_cover(base, left, radius, bar)
    d = ImageDraw.Draw(base)
    text(d, (left[0] + side / 2, left[3] - bar_h + 4.5 * S), "Song Title",
         font(13 * S), (245, 245, 247, 170), anchor="ma")

    # ---- hovered: same cover under the full frosted overlay, both control rows
    art_cover(base, right, radius, c1, c2)
    x0, y0, x1, y1 = [W_(v) for v in right]
    over = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 148))
    _clip_to_cover(base, right, radius, over)
    d = ImageDraw.Draw(base)
    cx = right[0] + side / 2
    cy = right[1] + side / 2
    row_dy = (17 + 34) / 2 * S        # VStack(spacing: 17) between two 34pt rows
    step = (34 + 11) * S              # HStack(spacing: 11) between 34pt frames
    glyph = 26 * S                    # .font(.system(size: 26))

    # Real SF Symbols, same names and sizes the bundle asks for. The secondary row sits
    # at V1's off-state ink (.secondary at 0.7), the transport row at its plain .secondary.
    off = (245, 245, 247, 98)
    on = (245, 245, 247, 140)
    sf(base, "shuffle", cx - step, cy - row_dy, glyph, off)
    sf(base, "repeat", cx, cy - row_dy, glyph, off)
    sf(base, "heart", cx + step, cy - row_dy, glyph, off)
    sf(base, "backward.end.fill", cx - step, cy + row_dy, glyph, on)
    sf(base, "play.fill", cx, cy + row_dy, glyph, on)
    sf(base, "forward.end.fill", cx + step, cy + row_dy, glyph, on)
    save(base, "V3")


if __name__ == "__main__":
    headline()
    strip()
    charts()
    scrobbles()
    glass()
    sleeve()
    stack()
    v3()
    print("done")
