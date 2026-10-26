"""Constructed letterforms for the "Maxify" wordmark (y-down, baseline at y=0)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from geom import (
    band,
    fmt,
    intersect,
    keep_above,
    keep_below,
    keep_left,
    keep_right,
    keep_side,
    poly_path,
    rect,
    rrect_path,
)


@dataclass
class Metrics:
    C: float = 140   # cap height
    X: float = 104   # x-height
    W: float = 20    # vertical stem
    Wh: float = 17   # horizontal stroke
    Wd: float = 19   # diagonal stroke (perpendicular)
    O: float = 2     # overshoot for rounds
    Af: float = 146  # f / i-dot top
    D: float = 44    # descender


@dataclass
class Glyph:
    paths: list[str] = field(default_factory=list)
    width: float = 0


def g_M(m: Metrics, Mw: float = 134, vb: float = 34) -> Glyph:
    g = Glyph(width=Mw)
    g.paths.append(poly_path(rect(0, -m.C, m.W, 0)))
    g.paths.append(poly_path(rect(Mw - m.W, -m.C, Mw, 0)))
    d = (Mw / 2, m.C - vb)  # outer (lower-left) edge from (0,-C) to the V bottom
    left = band((0, -m.C), d, m.Wd, toward=-1)
    left = keep_below(left, -m.C)
    left = keep_left(left, Mw / 2)
    left = keep_right(left, 0)
    g.paths.append(poly_path(left))
    right = [(Mw - x, y) for x, y in left]
    g.paths.append(poly_path(right))
    return g


def g_a(m: Metrics, Aw: float = 94, ro: float = 38, ri: float = 19) -> Glyph:
    g = Glyph(width=Aw)
    top, bot = -m.X - m.O, m.O
    g.paths.append(rrect_path(0, top, Aw, bot, ro, cw=True))
    g.paths.append(rrect_path(m.W, top + m.Wh, Aw - m.W, bot - m.Wh, ri, cw=False))
    g.paths.append(poly_path(rect(Aw - m.W, -m.X, Aw, 0)))
    return g


def _x_halfwidth(m: Metrics, span: float) -> float:
    h = m.Wd
    for _ in range(50):
        h = m.Wd * math.hypot(span - h, m.X) / m.X
    return h


def g_x(m: Metrics, Xw: float = 90) -> Glyph:
    g = Glyph(width=Xw)
    h = _x_halfwidth(m, Xw)
    d = (Xw - h, -m.X)  # up-right
    b1 = band((0, 0), d, m.Wd, toward=+1)
    b1 = keep_below(keep_above(b1, 0), -m.X)
    g.paths.append(poly_path(b1))
    g.paths.append(poly_path([(Xw - x, y) for x, y in b1]))
    return g


def g_i(m: Metrics, dot: float = 22, dot_top: float | None = None) -> Glyph:
    g = Glyph(width=m.W)
    g.paths.append(poly_path(rect(0, -m.X, m.W, 0)))
    top = -(dot_top if dot_top is not None else m.Af)
    off = (dot - m.W) / 2
    g.paths.append(poly_path(rect(-off, top, m.W + off, top + dot)))
    return g


def g_f(m: Metrics, fs: float = 12, rf: float = 34, hook: float = 52, bar_r: float = 28) -> Glyph:
    """fs: crossbar overhang left of stem; rf: outer hook radius; hook: terminal x from stem left."""
    g = Glyph(width=fs + max(hook, m.W + bar_r))
    top = -m.Af
    x0 = fs
    d = (
        f"M{fmt(x0)} 0V{fmt(top + rf)}"
        f"A{fmt(rf)} {fmt(rf)} 0 0 1 {fmt(x0 + rf)} {fmt(top)}"
        f"H{fmt(x0 + hook)}V{fmt(top + m.Wh)}H{fmt(x0 + rf)}"
        f"A{fmt(rf - m.W)} {fmt(rf - m.Wh)} 0 0 0 {fmt(x0 + m.W)} {fmt(top + rf)}"
        f"V0Z"
    )
    g.paths.append(d)
    g.paths.append(poly_path(rect(0, -m.X, x0 + m.W + bar_r, -m.X + m.Wh)))
    return g


def g_y(m: Metrics, Yw: float = 98, jy: float = -6) -> Glyph:
    """jy: height (y-down) where the left arm's outer edge meets the right arm's inner edge."""
    g = Glyph(width=Yw)
    # solve the arm angle so that the junction lands at y = jy
    lo, hi = math.radians(45), math.radians(85)
    for _ in range(80):
        phi = (lo + hi) / 2
        c, s = math.cos(phi), math.sin(phi)
        h = m.Wd / s
        dl, dr = (c, s), (-c, s)
        j = intersect((0, -m.X), dl, (Yw - h, -m.X), dr)
        if j[1] > jy:  # junction too low -> arms too steep -> decrease angle
            hi = phi
        else:
            lo = phi
    right = band((Yw, -m.X), dr, m.Wd, toward=+1)
    right = keep_below(keep_above(right, m.D), -m.X)
    left = band((0, -m.X), dl, m.Wd, toward=-1)
    left = keep_below(left, -m.X)
    left = keep_side(left, (Yw, -m.X), (Yw + dr[0], -m.X + dr[1]), side=+1)
    g.paths.append(poly_path(left))
    g.paths.append(poly_path(right))
    g.width = Yw
    return g
