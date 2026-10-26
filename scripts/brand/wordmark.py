"""Compose the Maxify wordmark from constructed glyphs."""
from __future__ import annotations

from geom import transform_path, translate_path
from glyphs import Metrics, g_M, g_a, g_f, g_i, g_x, g_y

M_DEFAULT = Metrics()

# gap (in units) placed *before* each glyph box
SPACING = {"a": 18, "x": 10, "i": 12, "f": 13, "y": 6}


def build(m: Metrics = M_DEFAULT, spacing: dict | None = None):
    sp = {**SPACING, **(spacing or {})}
    seq = [("M", g_M(m, Mw=128)), ("a", g_a(m, ro=40, ri=21)), ("x", g_x(m)), ("i", g_i(m)), ("f", g_f(m)), ("y", g_y(m))]
    x = 0.0
    out: list[tuple[str, str]] = []
    for name, g in seq:
        x += sp.get(name, 0)
        for p in g.paths:
            out.append((name, translate_path(p, x, 0)))
        x += g.width
    return out, x  # (glyph, path) list, total advance


def glyph_paths(k: float = 1, dx: float = 0, dy: float = 0, m: Metrics = M_DEFAULT) -> tuple[list[tuple[str, str]], float]:
    """[(glyph, d)] with one merged path per glyph, scaled by k, origin at (dx, dy) on the baseline."""
    parts, width = build(m)
    merged: dict[str, str] = {}
    for name, p in parts:
        merged[name] = merged.get(name, "") + transform_path(p, k, dx, dy)
    return list(merged.items()), width


def path_d(m: Metrics = M_DEFAULT, spacing: dict | None = None, dx: float = 0, dy: float = 0, k: float = 1) -> tuple[str, float]:
    """Wordmark outline scaled by k, baseline-left origin moved to (dx, dy). Returns (d, unscaled width)."""
    parts, width = build(m, spacing)
    return "".join(transform_path(p, k, dx, dy) for _, p in parts), width


if __name__ == "__main__":
    import pathlib

    d, w = path_d(dx=40, dy=200)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w + 80:.0f} 290">'
        '<rect width="100%" height="100%" fill="#fff"/>'
        '<g stroke="#e33" stroke-width="0.5" opacity="0.5">'
        f'<path d="M0 200H{w + 80:.0f}M0 96H{w + 80:.0f}M0 60H{w + 80:.0f}M0 54H{w + 80:.0f}M0 244H{w + 80:.0f}"/></g>'
        f'<path d="{d}" fill="#0F1A2A"/></svg>'
    )
    out = pathlib.Path(__file__).parent / "wm_test.svg"
    out.write_text(svg, encoding="utf-8")
    print(f"width={w:.1f}")
