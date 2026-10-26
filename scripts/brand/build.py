"""Build every Maxify brand SVG from one set of tokens.

usage: python build.py <out_dir>
"""
from __future__ import annotations

import pathlib
import sys

from geom import fmt
from scene import code_scene
from wordmark import glyph_paths

# ---------------------------------------------------------------- tokens
INK = "#0F1A2A"        # mark tile, wordmark on light, dark surfaces
SIGNAL = "#FFB938"     # the exact line (only accent)
PAPER = "#F4F6F9"      # light surface, bracket, wordmark on dark
SLATE_600 = "#4A5970"  # secondary text on light
SLATE_500 = "#56677F"  # context lines inside the tile
SLATE_300 = "#9DABBE"  # secondary text on dark

MONO = (
    "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', "
    "Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace"
)
TAGLINE = "Exact context. Fewer tokens."
DESCRIPTOR = "Local MCP server and CLI for Claude Code"

# ---------------------------------------------------------------- mark (32-unit grid)
TILE_R = 7
MARK_CONTEXT = [(6, 5, 15, 7), (6, 9, 18, 11), (6, 21, 17, 23), (6, 25, 12, 27)]
MARK_BRACKET = [(21, 4, 23, 12), (19, 4, 21, 6), (21, 20, 23, 28), (19, 26, 21, 28)]
MARK_SIGNAL = (6, 14, 27, 18)

# favicon: the same mark hinted to a 16-unit pixel grid
FAV_R = 3.5
FAV_CONTEXT = [(3, 3, 7, 4), (3, 5, 8, 6), (3, 10, 7, 11), (3, 12, 6, 13)]
FAV_BRACKET = [(10, 2, 12, 6), (8, 2, 10, 3), (10, 10, 12, 14), (8, 13, 10, 14)]
FAV_SIGNAL = (3, 7, 14, 9)

# lockup geometry, in wordmark units (cap height 140)
CAP, TILE, GAP, DESC = 140, 184, 50, 44


def rects_d(rects, s: float = 1, dx: float = 0, dy: float = 0) -> str:
    return "".join(
        f"M{fmt(dx + x0 * s)} {fmt(dy + y0 * s)}H{fmt(dx + x1 * s)}V{fmt(dy + y1 * s)}H{fmt(dx + x0 * s)}Z"
        for x0, y0, x1, y1 in rects
    )


def rrect_d(x: float, y: float, w: float, h: float, r: float) -> str:
    return (
        f"M{fmt(x + r)} {fmt(y)}H{fmt(x + w - r)}A{fmt(r)} {fmt(r)} 0 0 1 {fmt(x + w)} {fmt(y + r)}"
        f"V{fmt(y + h - r)}A{fmt(r)} {fmt(r)} 0 0 1 {fmt(x + w - r)} {fmt(y + h)}"
        f"H{fmt(x + r)}A{fmt(r)} {fmt(r)} 0 0 1 {fmt(x)} {fmt(y + h - r)}"
        f"V{fmt(y + r)}A{fmt(r)} {fmt(r)} 0 0 1 {fmt(x + r)} {fmt(y)}Z"
    )


def mark_group(size: float, dx: float, dy: float, rim: bool, indent: str = "  ") -> str:
    """The mark, `size` px square, top-left corner at (dx, dy)."""
    s = size / 32
    out = [f'{indent}<g id="mark">', f'{indent}  <path fill="{INK}" d="{rrect_d(dx, dy, size, size, TILE_R * s)}"/>']
    if rim:
        i = 0.25 * s
        out.append(
            f'{indent}  <!-- hairline rim: keeps the tile edge visible on dark surfaces -->\n'
            f'{indent}  <path fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="{fmt(0.5 * s)}" '
            f'd="{rrect_d(dx + i, dy + i, size - 2 * i, size - 2 * i, TILE_R * s - i)}"/>'
        )
    out += [
        f'{indent}  <path fill="{SLATE_500}" d="{rects_d(MARK_CONTEXT, s, dx, dy)}"/>',
        f'{indent}  <path fill="{PAPER}" d="{rects_d(MARK_BRACKET, s, dx, dy)}"/>',
        f'{indent}  <path fill="{SIGNAL}" d="{rects_d([MARK_SIGNAL], s, dx, dy)}"/>',
        f"{indent}</g>",
    ]
    return "\n".join(out)


def wordmark_group(k: float, dx: float, dy: float, fill: str, indent: str = "  ") -> tuple[str, float]:
    """Wordmark scaled by k; (dx, dy) is the tile's top-left. Returns (svg, lockup width)."""
    baseline = dy + k * (TILE / 2 + CAP / 2)  # cap height centred on the tile
    glyphs, word_w = glyph_paths(k=k, dx=dx + k * (TILE + GAP), dy=baseline)
    rows = [f'{indent}<g id="wordmark" fill="{fill}">']
    rows += [f'{indent}  <path d="{d}"/><!-- {name} -->' for name, d in glyphs]
    rows.append(f"{indent}</g>")
    return "\n".join(rows), k * (TILE + GAP + word_w)


# ---------------------------------------------------------------- deliverables
def logo_mark() -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="256" height="256" role="img" aria-labelledby="title">
  <title id="title">Maxify</title>
  <!-- Maxify mark, 32-unit grid. Context lines are held by a bracket; only the exact line passes through its slot. -->
  <path fill="{INK}" d="{rrect_d(0, 0, 32, 32, TILE_R)}"/>
  <path fill="{SLATE_500}" d="{rects_d(MARK_CONTEXT)}"/>
  <path fill="{PAPER}" d="{rects_d(MARK_BRACKET)}"/>
  <path fill="{SIGNAL}" d="{rects_d([MARK_SIGNAL])}"/>
</svg>
"""


def favicon() -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32">
  <!-- Maxify favicon: the mark hinted to a 16-unit pixel grid (1px context lines and bracket arms). -->
  <path fill="{INK}" d="{rrect_d(0, 0, 16, 16, FAV_R)}"/>
  <path fill="{SLATE_500}" d="{rects_d(FAV_CONTEXT)}"/>
  <path fill="{PAPER}" d="{rects_d(FAV_BRACKET)}"/>
  <path fill="{SIGNAL}" d="{rects_d([FAV_SIGNAL])}"/>
</svg>
"""


def logo_wordmark(theme: str) -> str:
    dark = theme == "dark"
    word, w = wordmark_group(1, 0, 0, PAPER if dark else INK)
    h = TILE / 2 + CAP / 2 + DESC  # tile top to the bottom of the y descender
    disp_h = 64
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" width="{fmt(w * disp_h / h)}" height="{disp_h}" role="img" aria-labelledby="title">
  <title id="title">Maxify</title>
  <!-- Maxify lockup for {"dark" if dark else "light"} backgrounds. Letters are constructed outlines: no fonts required. -->
{mark_group(TILE, 0, 0, rim=dark)}
{word}
</svg>
"""


THEMES = {
    "light": dict(panel=PAPER, word=INK, tag=SLATE_600, far="#E4E9EF", near="#C3CDD9", bracket=INK, rim=False),
    "dark": dict(panel=INK, word=PAPER, tag=SLATE_300, far="#172436", near="#3A4C66", bracket=PAPER, rim=True),
}


def banner(theme: str) -> str:
    t = THEMES[theme]
    W, H, R = 1280, 320, 16
    left, tile_px, tile_top = 88, 96, 88
    k = tile_px / TILE
    word, lw = wordmark_group(k, left, tile_top, t["word"])
    axis = tile_top + tile_px / 2
    scene = code_scene(
        x0=712, axis_y=axis, pitch=16, cw=6, bar_h=5, max_cols=60, bracket_x=1094, bracket_w=5, arm=18,
        hold=4, slot=26, exact_h=10, exact_x1=W, y_min=20, y_max=H - 20, exact_cols0=4,
        c_far=t["far"], c_near=t["near"], c_bracket=t["bracket"], c_exact=SIGNAL, indent="    ",
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc">
  <title id="title">Maxify</title>
  <desc id="desc">{TAGLINE}</desc>
  <defs>
    <clipPath id="panel"><path d="{rrect_d(0, 0, W, H, R)}"/></clipPath>
  </defs>
  <path fill="{t["panel"]}" d="{rrect_d(0, 0, W, H, R)}"/>
  <!-- Supergraphic: the silhouette of real TypeScript, one bar per run of characters. -->
  <g clip-path="url(#panel)">
{scene}
  </g>
{mark_group(tile_px, left, tile_top, rim=t["rim"])}
{word}
  <!-- Tagline: live text in the platform monospace face; textLength pins it to the lockup width. -->
  <text x="{left}" y="{tile_top + tile_px + 46}" fill="{t["tag"]}" font-family="{MONO}" font-size="24" textLength="{fmt(lw)}" lengthAdjust="spacing">{TAGLINE}</text>
</svg>
"""


def social() -> str:
    t = THEMES["dark"]
    W, H = 1280, 640
    left, tile_px, tile_top = 96, 128, 196
    k = tile_px / TILE
    word, lw = wordmark_group(k, left, tile_top, t["word"])
    axis = tile_top + tile_px / 2
    tag_base = tile_top + tile_px + 64
    scene = code_scene(
        x0=748, axis_y=axis, pitch=21, cw=6.2, bar_h=6, max_cols=58, bracket_x=1124, bracket_w=6, arm=22,
        hold=4, slot=34, exact_h=13, exact_x1=W, y_min=0, y_max=H, exact_cols0=4,
        c_far=t["far"], c_near=t["near"], c_bracket=t["bracket"], c_exact=SIGNAL, indent="  ",
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="title desc">
  <title id="title">Maxify MCP</title>
  <desc id="desc">{TAGLINE} {DESCRIPTOR}.</desc>
  <!-- Source for social-preview.png (1280x640). Keep text inside x 96-1184 for platform crops. -->
  <rect width="{W}" height="{H}" fill="{t["panel"]}"/>
{scene}
{mark_group(tile_px, left, tile_top, rim=True)}
{word}
  <text x="{left}" y="{tag_base}" fill="{PAPER}" font-family="{MONO}" font-size="32" textLength="{fmt(lw)}" lengthAdjust="spacing">{TAGLINE}</text>
  <text x="{left}" y="{tag_base + 50}" fill="{t["tag"]}" font-family="{MONO}" font-size="21">{DESCRIPTOR}</text>
</svg>
"""


def write(out: pathlib.Path, name: str, body: str) -> None:
    (out / name).write_text(body, encoding="utf-8", newline="\n")
    print(f"  {name} ({len(body.encode()) / 1024:.1f} KB)")


if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    write(out, "logo-mark.svg", logo_mark())
    write(out, "favicon.svg", favicon())
    write(out, "logo-wordmark-light.svg", logo_wordmark("light"))
    write(out, "logo-wordmark-dark.svg", logo_wordmark("dark"))
    write(out, "banner-light.svg", banner("light"))
    write(out, "banner-dark.svg", banner("dark"))
    write(out, "social-preview.svg", social())
