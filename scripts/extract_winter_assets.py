#!/usr/bin/env python3
"""Slice winter-theme sprites into a new atlas page (gameplay7.png) and append
its region entries to gameplay.atlas (libGDX text atlas format).

Sources
-------
* packages/client/public/assets/winter_map.png  -- 2048x2048 RGBA rip of the
  Bomb-It winter theme sheet (v2). Provides bottle / cans / sled / mallet /
  shotgun / ice tile / snow block art at full resolution.
* a synthesized snow lodge + window pane drawn with PIL (the v2 sheet contains
  no house and no window-pane block; the only other candidate was a blurry,
  white-backgrounded scene crop from the deleted v1 sheet).

Outputs (nothing else is touched)
---------------------------------
* packages/client/public/assets/gameplay7.png
* packages/client/public/assets/gameplay.atlas  (gameplay7 section appended /
  replaced in place -- existing pages are never modified)

NOTE: this repo's shell hook corrupts `cmd > file` redirection, so every file
is written from Python.

Run:  python3 scripts/extract_winter_assets.py [--debug]
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "packages", "client", "public", "assets")
SRC_SHEET = os.path.join(ASSETS, "winter_map.png")
OUT_PNG = os.path.join(ASSETS, "gameplay7.png")
ATLAS = os.path.join(ASSETS, "gameplay.atlas")
PAGE_NAME = "gameplay7.png"
PAGE_W, PAGE_H = 512, 256

TILE = 64
HOUSE = 192
PAD = 2  # transparent margin kept inside each 64x64 cell

# --- crop boxes in winter_map.png (left, top, right, bottom) ----------------
# Derived from connected-component analysis of the alpha channel.
BOX_BOTTLE = (124, 544, 212, 755)  # single green bottle (cluster is built from it)
BOX_CANS = (325, 547, 504, 760)  # pink bunny-logo can trio
BOX_SLED = (89, 793, 264, 986)  # red sled
BOX_MALLET = (815, 789, 1007, 996)  # wooden mallet / hammer
BOX_SHOTGUN = (547, 1331, 777, 1417)  # shotgun (wide, laid out horizontally)
BOX_ICE = (1295, 1262, 1526, 1486)  # bright light-blue ice tile
BOX_SNOWBLOCK = (1755, 1262, 1983, 1486)  # plain snow block (window-pane base)

GUN_ROTATION = 20  # deg, so the wide shotgun fills the square cell


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def fit_center(img: Image.Image, size: int = TILE, pad: int = PAD) -> Image.Image:
    """Scale `img` to fit inside size-2*pad and center it on a transparent cell."""
    inner = size - 2 * pad
    scale = min(inner / img.width, inner / img.height)
    w = max(1, round(img.width * scale))
    h = max(1, round(img.height * scale))
    resample = Image.LANCZOS
    scaled = img.resize((w, h), resample)
    cell = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cell.paste(scaled, ((size - w) // 2, (size - h) // 2), scaled)
    return cell


def fill_cell(img: Image.Image, size: int = TILE) -> Image.Image:
    """Scale a tile sprite to exactly fill the cell (used for floor tiles)."""
    return img.resize((size, size), Image.LANCZOS)


def trim(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


# ---------------------------------------------------------------------------
# frame builders
# ---------------------------------------------------------------------------
def build_bottles(sheet: Image.Image) -> Image.Image:
    """The v2 sheet only has one bottle; stack three into a cluster."""
    bottle = trim(sheet.crop(BOX_BOTTLE))
    bw, bh = bottle.size
    canvas = Image.new("RGBA", (int(bw * 2.5), int(bh * 1.16)), (0, 0, 0, 0))
    base_y = canvas.height - bh

    def place(scale: float, x: float, y: float, shade: float = 1.0):
        w = max(1, int(bw * scale))
        h = max(1, int(bh * scale))
        s = bottle.resize((w, h), Image.LANCZOS)
        if shade != 1.0:
            r, g, b, a = s.split()
            s = Image.merge(
                "RGBA",
                (
                    r.point(lambda v: int(v * shade)),
                    g.point(lambda v: int(v * shade)),
                    b.point(lambda v: int(v * shade)),
                    a,
                ),
            )
        canvas.paste(s, (int(x), int(y)), s)

    # two shaded bottles behind, one bright bottle in front
    place(0.86, bw * 0.10, base_y - bh * 0.10, 0.88)
    place(0.86, bw * 1.06, base_y - bh * 0.10, 0.88)
    place(1.00, bw * 0.60, base_y, 1.0)
    return fit_center(trim(canvas))


def build_gun(sheet: Image.Image) -> Image.Image:
    gun = trim(sheet.crop(BOX_SHOTGUN))
    gun = gun.rotate(GUN_ROTATION, resample=Image.BICUBIC, expand=True)
    return fit_center(trim(gun))


def _rr(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build_window(sheet: Image.Image) -> Image.Image:
    """Snow block from the sheet + a hand-drawn white window pane on top."""
    S = 4  # supersample factor
    size = TILE * S
    base = sheet.crop(BOX_SNOWBLOCK).resize((size, size), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(base, (0, 0), base)

    pane = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(pane)
    m = 7 * S  # margin from tile edge
    frame = (m, m, size - m, size - m)
    outline = (74, 106, 140, 255)
    # outer frame (soft white, cool shadow line)
    _rr(d, frame, 3 * S, fill=(250, 252, 255, 255), outline=outline, width=int(1.5 * S))
    # glass area
    g = 5 * S
    glass = (frame[0] + g, frame[1] + g, frame[2] - g, frame[3] - g)
    _rr(d, glass, 2 * S, fill=(146, 199, 231, 255), outline=outline, width=S)
    # glass gradient / highlight
    gw = glass[2] - glass[0]
    gh = glass[3] - glass[1]
    hl = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.polygon(
        [(0, gh), (gw * 0.42, 0), (gw * 0.70, 0), (0, gh * 0.62)],
        fill=(255, 255, 255, 120),
    )
    hd.polygon(
        [(gw * 0.60, gh), (gw * 0.92, 0), (gw, 0), (gw * 0.78, gh)],
        fill=(255, 255, 255, 70),
    )
    hl = hl.filter(ImageFilter.GaussianBlur(S))
    pane.paste(hl, (glass[0], glass[1]), hl)
    # muntins (window cross)
    cx = (glass[0] + glass[2]) // 2
    cy = (glass[1] + glass[3]) // 2
    t = int(2.0 * S)
    d.rectangle((cx - t, glass[1], cx + t, glass[3]), fill=(250, 252, 255, 255))
    d.rectangle((glass[0], cy - t, glass[2], cy + t), fill=(250, 252, 255, 255))
    for lx in (cx - t, cx + t):
        d.line((lx, glass[1], lx, glass[3]), fill=outline, width=S)
    for ly in (cy - t, cy + t):
        d.line((glass[0], ly, glass[2], ly), fill=outline, width=S)
    tile.paste(pane, (0, 0), pane)

    # snow resting on the top edge of the frame + on the sill
    snow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(snow)
    shadow = (198, 226, 243, 255)
    for i in range(5):  # soft blue underside first, white on top of it
        x = m - S + i * ((size - 2 * m + 2 * S) / 4.0)
        sd.ellipse((x - 5 * S, m + S, x + 5 * S, m + 9 * S), fill=shadow)
    sd.rounded_rectangle(
        (m - 3 * S, m - 4 * S, size - m + 3 * S, m + 5 * S), radius=3 * S, fill=shadow
    )
    for i in range(5):
        x = m - S + i * ((size - 2 * m + 2 * S) / 4.0)
        sd.ellipse((x - 4 * S, m - S, x + 4 * S, m + 6 * S), fill=(255, 255, 255, 255))
    sd.rounded_rectangle(
        (m - 2 * S, m - 4 * S, size - m + 2 * S, m + 3 * S), radius=3 * S, fill=(255, 255, 255, 255)
    )
    sd.rounded_rectangle(
        (m - 4 * S, size - m - 2 * S, size - m + 4 * S, size - m + 4 * S),
        radius=2 * S,
        fill=shadow,
    )
    sd.rounded_rectangle(
        (m - 3 * S, size - m - 3 * S, size - m + 3 * S, size - m + 2 * S),
        radius=2 * S,
        fill=(255, 255, 255, 255),
    )
    snow_mask = base.split()[3]
    snow.putalpha(Image.composite(snow.split()[3], Image.new("L", (size, size), 0), snow_mask))
    tile.paste(snow, (0, 0), snow)

    return tile.resize((TILE, TILE), Image.LANCZOS)


def build_house() -> Image.Image:
    """Draw a snow-roofed wooden lodge (no house exists on the v2 sheet)."""
    S = 4
    W = HOUSE * S
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def P(*pts):
        return [(x * S, y * S) for x, y in pts]

    WOOD = (204, 146, 84, 255)
    WOOD_DK = (168, 112, 58, 255)
    LINE = (104, 62, 28, 255)
    ROOF = (140, 84, 44, 255)
    SNOW = (255, 255, 255, 255)
    SNOW_SH = (206, 231, 245, 255)
    GLOW = (255, 214, 92, 255)
    GLOW_HI = (255, 240, 170, 255)

    # ---- ground snow drift ------------------------------------------------
    for cx, cy, rx, ry in ((44, 176, 40, 13), (96, 180, 52, 15), (150, 176, 40, 13)):
        d.ellipse(P((cx - rx, cy - ry), (cx + rx, cy + ry)), fill=SNOW_SH)
    for cx, cy, rx, ry in ((48, 174, 34, 10), (96, 177, 46, 12), (146, 174, 34, 10)):
        d.ellipse(P((cx - rx, cy - ry), (cx + rx, cy + ry)), fill=SNOW)

    # ---- body -------------------------------------------------------------
    body = P((30, 96), (162, 174))
    d.rounded_rectangle(body, radius=3 * S, fill=WOOD, outline=LINE, width=int(1.6 * S))
    for y in (110, 124, 138, 152, 166):
        d.line(P((32, y), (160, y)), fill=WOOD_DK, width=max(1, S // 2))
    # corner posts
    d.rectangle(P((30, 96), (40, 174)), fill=WOOD_DK)
    d.rectangle(P((152, 96), (162, 174)), fill=WOOD_DK)
    d.rounded_rectangle(body, radius=3 * S, outline=LINE, width=int(1.6 * S))

    # ---- door -------------------------------------------------------------
    d.rounded_rectangle(
        P((84, 128), (108, 174)), radius=2 * S, fill=(126, 78, 40, 255), outline=LINE, width=int(1.4 * S)
    )
    d.line(P((96, 130), (96, 172)), fill=LINE, width=max(1, S // 2))
    d.ellipse(P((100, 150), (104, 154)), fill=GLOW)

    # ---- windows ----------------------------------------------------------
    for x0 in (48, 122):
        win = P((x0, 112), (x0 + 24, 136))
        d.rounded_rectangle(win, radius=S, fill=GLOW, outline=LINE, width=int(1.4 * S))
        d.rounded_rectangle(
            P((x0 + 3, 115), (x0 + 21, 133)), radius=S, fill=GLOW_HI
        )
        d.line(P((x0 + 12, 112), (x0 + 12, 136)), fill=LINE, width=max(1, S // 2))
        d.line(P((x0, 124), (x0 + 24, 124)), fill=LINE, width=max(1, S // 2))
        # snow on the sill
        d.rounded_rectangle(P((x0 - 3, 134), (x0 + 27, 140)), radius=2 * S, fill=SNOW)

    # ---- chimney (drawn before the roof so the roof overlaps its base) -----
    d.rectangle(P((132, 34), (152, 78)), fill=(178, 84, 64, 255), outline=LINE, width=int(1.6 * S))
    for y in (48, 58, 68):
        d.line(P((132, y), (152, y)), fill=(140, 60, 44, 255), width=max(1, S // 2))

    # ---- roof -------------------------------------------------------------
    d.polygon(P((12, 104), (96, 38), (180, 104)), fill=ROOF)
    d.line(P((12, 104), (96, 38), (180, 104)), fill=LINE, width=int(1.8 * S), joint="curve")
    d.line(P((12, 104), (180, 104)), fill=LINE, width=int(1.6 * S))
    # snow blanket on the roof
    d.polygon(P((20, 97), (96, 43), (172, 97)), fill=SNOW)
    d.polygon(P((20, 97), (96, 43), (110, 54), (44, 97)), fill=(240, 249, 255, 255))
    # scalloped snow overhang along the eaves
    for i in range(9):
        x = 20 + i * 19
        d.ellipse(P((x - 11, 90), (x + 11, 104)), fill=SNOW)
    # chimney snow cap
    d.rounded_rectangle(P((128, 28), (156, 40)), radius=3 * S, fill=SNOW, outline=LINE, width=int(1.4 * S))

    # ---- porch / base trim ------------------------------------------------
    d.rounded_rectangle(P((26, 168), (166, 176)), radius=2 * S, fill=WOOD_DK, outline=LINE, width=int(1.4 * S))
    for cx, cy, rx, ry in ((40, 176, 22, 8), (96, 179, 30, 9), (152, 176, 22, 8)):
        d.ellipse(P((cx - rx, cy - ry), (cx + rx, cy + ry)), fill=SNOW)

    return img.resize((HOUSE, HOUSE), Image.LANCZOS)


# ---------------------------------------------------------------------------
# page packing
# ---------------------------------------------------------------------------
def build_page() -> tuple[Image.Image, list[tuple[str, int, int, int, int]]]:
    sheet = Image.open(SRC_SHEET).convert("RGBA")

    frames = {
        "winter_house": build_house(),
        "winter_soft_bottles": build_bottles(sheet),
        "winter_soft_cans": fit_center(trim(sheet.crop(BOX_CANS))),
        "winter_soft_sled": fit_center(trim(sheet.crop(BOX_SLED))),
        "winter_soft_window": build_window(sheet),
        "winter_floor_ice": fill_cell(sheet.crop(BOX_ICE)),
        "winter_gun": build_gun(sheet),
        "winter_hammer": fit_center(trim(sheet.crop(BOX_MALLET))),
    }

    # 2px padding everywhere; house occupies the left 192x192 block
    placement = [
        ("winter_house", 2, 2),
        ("winter_soft_bottles", 196, 2),
        ("winter_soft_cans", 262, 2),
        ("winter_soft_sled", 328, 2),
        ("winter_soft_window", 394, 2),
        ("winter_floor_ice", 196, 68),
        ("winter_gun", 262, 68),
        ("winter_hammer", 328, 68),
    ]

    page = Image.new("RGBA", (PAGE_W, PAGE_H), (0, 0, 0, 0))
    regions = []
    for name, x, y in placement:
        img = frames[name]
        assert x + img.width <= PAGE_W and y + img.height <= PAGE_H, name
        page.paste(img, (x, y))
        regions.append((name, x, y, img.width, img.height))
    return page, regions


def atlas_section(regions) -> str:
    lines = [
        "",
        PAGE_NAME,
        "size: %d, %d" % (PAGE_W, PAGE_H),
        "format: RGBA8888",
        "filter: Nearest, Nearest",
        "repeat: none",
    ]
    for name, x, y, w, h in regions:
        lines += [
            name,
            "  rotate: false",
            "  xy: %d, %d" % (x, y),
            "  size: %d, %d" % (w, h),
            "  orig: %d, %d" % (w, h),
            "  offset: 0, 0",
            "  index: -1",
        ]
    return "\n".join(lines) + "\n"


def write_atlas(regions) -> None:
    with open(ATLAS, "r", encoding="utf-8") as fh:
        text = fh.read()
    # idempotent re-run: drop only the previous gameplay7 section, keeping any
    # sections that happen to follow it.
    marker = "\n" + PAGE_NAME + "\n"
    idx = text.find(marker)
    if idx != -1:
        end = text.find("\n\n", idx + len(marker))
        text = text[:idx] + ("" if end == -1 else text[end:])
    text = text.rstrip("\n") + "\n" + atlas_section(regions)
    with open(ATLAS, "w", encoding="utf-8") as fh:
        fh.write(text)


def debug_contact_sheet(regions, page: Image.Image, path: str) -> None:
    scale = 2
    cell_w = HOUSE * scale + 16
    cols = 4
    rows = (len(regions) + cols - 1) // cols
    out = Image.new("RGBA", (cols * cell_w, rows * (cell_w + 20)), (32, 32, 40, 255))
    d = ImageDraw.Draw(out)
    for i, (name, x, y, w, h) in enumerate(regions):
        cx = (i % cols) * cell_w
        cy = (i // cols) * (cell_w + 20)
        crop = page.crop((x, y, x + w, y + h)).resize((w * scale, h * scale), Image.NEAREST)
        # checkerboard behind so transparency is visible
        bg = Image.new("RGBA", crop.size, (255, 255, 255, 255))
        for by in range(0, crop.height, 16):
            for bx in range(0, crop.width, 16):
                if (bx // 16 + by // 16) % 2:
                    ImageDraw.Draw(bg).rectangle((bx, by, bx + 15, by + 15), fill=(200, 200, 210, 255))
        bg.paste(crop, (0, 0), crop)
        out.paste(bg, (cx + 8, cy + 18))
        d.rectangle((cx + 8, cy + 18, cx + 8 + crop.width, cy + 18 + crop.height), outline=(255, 90, 90, 255))
        d.text((cx + 8, cy + 4), "%s  %dx%d @%d,%d" % (name, w, h, x, y), fill=(255, 235, 120, 255))
    out.save(path)


def main() -> int:
    page, regions = build_page()
    page.save(OUT_PNG)
    write_atlas(regions)
    print("wrote", OUT_PNG, page.size)
    for r in regions:
        print("  %-22s xy: %3d, %3d  size: %3d, %3d" % (r[0], r[1], r[2], r[3], r[4]))
    print("updated", ATLAS)

    if "--debug" in sys.argv:
        dbg = os.environ.get("WINTER_DEBUG_DIR", "/tmp")
        debug_contact_sheet(regions, page, os.path.join(dbg, "winter_contact.png"))
        print("debug sheet ->", os.path.join(dbg, "winter_contact.png"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
