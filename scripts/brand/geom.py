"""Small geometry kit for constructing letterforms as filled outlines (SVG, y-down)."""
from __future__ import annotations

import math

Pt = tuple[float, float]
BIG = 10_000.0


def fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def signed_area(poly: list[Pt]) -> float:
    a = 0.0
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        a += x0 * y1 - x1 * y0
    return a / 2


def orient_cw(poly: list[Pt]) -> list[Pt]:
    """Clockwise on screen (y-down) == positive signed area."""
    return poly if signed_area(poly) > 0 else poly[::-1]


def poly_path(poly: list[Pt]) -> str:
    poly = orient_cw(poly)
    head = f"M{fmt(poly[0][0])} {fmt(poly[0][1])}"
    body = "".join(f"L{fmt(x)} {fmt(y)}" for x, y in poly[1:])
    return head + body + "Z"


def rect(x0: float, y0: float, x1: float, y1: float) -> list[Pt]:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def clip(poly: list[Pt], a: float, b: float, c: float) -> list[Pt]:
    """Keep the part of a convex polygon where a*x + b*y + c <= 0 (Sutherland-Hodgman)."""
    out: list[Pt] = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        fp, fq = a * p[0] + b * p[1] + c, a * q[0] + b * q[1] + c
        if fp <= 0:
            out.append(p)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def keep_below(poly, y):  # y-down: keep y >= value
    return clip(poly, 0, -1, y)


def keep_above(poly, y):  # keep y <= value
    return clip(poly, 0, 1, -y)


def keep_right(poly, x):  # keep x >= value
    return clip(poly, -1, 0, x)


def keep_left(poly, x):  # keep x <= value
    return clip(poly, 1, 0, -x)


def keep_side(poly, p0: Pt, p1: Pt, side: int) -> list[Pt]:
    """Keep the half-plane on one side of the line p0->p1 (side=+1 right of direction on screen, -1 left)."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    # cross(d, p - p0) = dx*(y - y0) - dy*(x - x0); on screen (y-down) > 0 means "right" of direction
    a, b = dy, -dx
    c = -(a * p0[0] + b * p0[1])
    # a*x + b*y + c = -(cross) ; keep cross*side >= 0  <=>  side*(a x + b y + c) <= 0
    return clip(poly, side * a, side * b, side * c)


def band(p_edge: Pt, direction: Pt, width: float, toward: int) -> list[Pt]:
    """Infinite strip of perpendicular `width` with one edge through p_edge along `direction`.

    toward=+1 puts the strip on the screen-right of the direction, -1 on the left.
    Returned as a very large quad, meant to be clipped.
    """
    dx, dy = direction
    L = math.hypot(dx, dy)
    ux, uy = dx / L, dy / L
    # screen-right normal of (ux, uy) in y-down coords is (-uy, ux)
    nx, ny = -uy * toward, ux * toward
    a = (p_edge[0] - ux * BIG, p_edge[1] - uy * BIG)
    b = (p_edge[0] + ux * BIG, p_edge[1] + uy * BIG)
    c = (b[0] + nx * width, b[1] + ny * width)
    d = (a[0] + nx * width, a[1] + ny * width)
    return [a, b, c, d]


def line_x_at(p: Pt, d: Pt, y: float) -> float:
    return p[0] + (y - p[1]) * d[0] / d[1]


def intersect(p: Pt, d: Pt, q: Pt, e: Pt) -> Pt:
    """Intersection of lines p + t d and q + s e."""
    den = d[0] * e[1] - d[1] * e[0]
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    return (p[0] + t * d[0], p[1] + t * d[1])


def rrect_path(x0, y0, x1, y1, r, cw=True, rx=None, ry=None) -> str:
    """Rounded rectangle; r may be a 4-tuple (tl, tr, br, bl). Elliptical corners via rx/ry scale."""
    if isinstance(r, (int, float)):
        r = (r, r, r, r)
    tl, tr, br, bl = r
    sx = 1.0 if rx is None else rx
    sy = 1.0 if ry is None else ry

    def arc(rr, x, y, sweep):
        if rr == 0:
            return f"L{fmt(x)} {fmt(y)}"
        return f"A{fmt(rr * sx)} {fmt(rr * sy)} 0 0 {sweep} {fmt(x)} {fmt(y)}"

    if cw:
        return (
            f"M{fmt(x0 + tl * sx)} {fmt(y0)}"
            f"H{fmt(x1 - tr * sx)}" + arc(tr, x1, y0 + tr * sy, 1) +
            f"V{fmt(y1 - br * sy)}" + arc(br, x1 - br * sx, y1, 1) +
            f"H{fmt(x0 + bl * sx)}" + arc(bl, x0, y1 - bl * sy, 1) +
            f"V{fmt(y0 + tl * sy)}" + arc(tl, x0 + tl * sx, y0, 1) + "Z"
        )
    return (
        f"M{fmt(x0 + tl * sx)} {fmt(y0)}"
        + arc(tl, x0, y0 + tl * sy, 0) +
        f"V{fmt(y1 - bl * sy)}" + arc(bl, x0 + bl * sx, y1, 0) +
        f"H{fmt(x1 - br * sx)}" + arc(br, x1, y1 - br * sy, 0) +
        f"V{fmt(y0 + tr * sy)}" + arc(tr, x1 - tr * sx, y0, 0) +
        f"H{fmt(x0 + tl * sx)}Z"
    )


def translate_path(d: str, dx: float, dy: float) -> str:
    """Translate an absolute path made of M/L/H/V/A/Z commands."""
    import re

    toks = re.findall(r"[MLHVAZ]|-?\d+(?:\.\d+)?", d)
    out, i, cmd = [], 0, None
    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t
            out.append(t)
            i += 1
            continue
        if cmd in ("M", "L"):
            out.append(f"{fmt(float(toks[i]) + dx)} {fmt(float(toks[i + 1]) + dy)}")
            i += 2
        elif cmd == "H":
            out.append(fmt(float(t) + dx))
            i += 1
        elif cmd == "V":
            out.append(fmt(float(t) + dy))
            i += 1
        elif cmd == "A":
            rx, ry, rot, la, sw, x, y = toks[i : i + 7]
            out.append(f"{rx} {ry} {rot} {la} {sw} {fmt(float(x) + dx)} {fmt(float(y) + dy)}")
            i += 7
        else:
            raise ValueError(f"unsupported token {t} after {cmd}")
    s = ""
    for tok in out:
        if s and not tok[0].isalpha() and not s[-1].isalpha():
            s += " "
        s += tok
    return s


def transform_path(d: str, k: float, dx: float, dy: float) -> str:
    """Scale by k then translate, for absolute M/L/H/V/A/Z paths."""
    import re

    toks = re.findall(r"[MLHVAZ]|-?\d+(?:\.\d+)?", d)
    out, i, cmd = [], 0, None
    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t
            out.append(t)
            i += 1
            continue
        if cmd in ("M", "L"):
            out.append(f"{fmt(float(toks[i]) * k + dx)} {fmt(float(toks[i + 1]) * k + dy)}")
            i += 2
        elif cmd == "H":
            out.append(fmt(float(t) * k + dx))
            i += 1
        elif cmd == "V":
            out.append(fmt(float(t) * k + dy))
            i += 1
        elif cmd == "A":
            rx, ry, rot, la, sw, x, y = toks[i : i + 7]
            out.append(
                f"{fmt(float(rx) * k)} {fmt(float(ry) * k)} {rot} {la} {sw} "
                f"{fmt(float(x) * k + dx)} {fmt(float(y) * k + dy)}"
            )
            i += 7
        else:
            raise ValueError(f"unsupported token {t} after {cmd}")
    s = ""
    for tok in out:
        if s and not tok[0].isalpha() and not s[-1].isalpha():
            s += " "
        s += tok
    return s
