"""The 'compile context' supergraphic: a code silhouette held by a bracket, one exact line passes."""
from __future__ import annotations

from geom import fmt

# Real TypeScript, used only for its silhouette (runs of non-space characters become bars).
CODE = """\
import { loadIndex } from "./index";
import { estimateTokens } from "./tokens";

export async function compile(task: Task, budget: number) {
  const index = await loadIndex(task.repo);
  const ranked = index.search(task.query);
  const evidence: Evidence[] = [];
  let used = 0;
  for (const hit of ranked) {
    const span = index.exactSource(hit.symbol);
    const cost = estimateTokens(span.text);
    if (used + cost > budget) continue;
    evidence.push({ span, signature: hit.signature });
    used += cost;
  }
  return { evidence, omitted: ranked.length - evidence.length };
}

export function recover(id: string) {
  return store.original(id);
}

export function compress(output: string, keep: number) {
  const lines = output.split("\\n");
  const id = store.save(output);
  const head = lines.slice(0, keep);
  const failures = lines.filter(isFailure);
  return { id, text: [...head, ...failures].join("\\n") };
}
"""
LINES = CODE.splitlines()
EXACT = next(i for i, l in enumerate(LINES) if l.strip().startswith("evidence.push"))


def runs(line: str, max_cols: int):
    """(start, end) column runs of non-space chars, clipped to max_cols."""
    out, i, n = [], 0, min(len(line), max_cols)
    while i < n:
        if line[i] == " ":
            i += 1
            continue
        j = i
        while j < n and line[j] != " ":
            j += 1
        out.append((i, j))
        i = j
    return out


def code_scene(
    *,
    x0: float,
    axis_y: float,
    pitch: float,
    cw: float,
    bar_h: float,
    max_cols: int,
    bracket_x: float,
    bracket_w: float,
    arm: float,
    hold: int,
    slot: float,
    exact_h: float,
    exact_x1: float,
    y_min: float,
    y_max: float,
    c_far: str,
    c_near: str,
    c_bracket: str,
    c_exact: str,
    exact_cols0: int = 0,
    indent: str = "  ",
) -> str:
    """SVG for the scene. Path data keeps one source line per row so the file stays readable."""
    far, near = [], []
    for i, line in enumerate(LINES):
        k = i - EXACT
        if k == 0:
            continue
        cy = axis_y + k * pitch
        if cy - bar_h / 2 < y_min or cy + bar_h / 2 > y_max:
            continue
        row = []
        line_runs = runs(line, max_cols)
        for a, b in line_runs:
            if len(line_runs) == 1 and b - a == 1:
                b = a + 2  # a line holding only a brace reads as a stray dot; draw it as a short dash
            row.append(
                f"M{fmt(x0 + a * cw)} {fmt(cy - bar_h / 2)}H{fmt(x0 + b * cw)}"
                f"V{fmt(cy + bar_h / 2)}H{fmt(x0 + a * cw)}Z"
            )
        if row:
            (near if abs(k) <= hold else far).append("".join(row))

    top = axis_y - hold * pitch - pitch / 2 - 2
    bot = axis_y + hold * pitch + pitch / 2 + 2
    bx0, bx1 = bracket_x, bracket_x + bracket_w
    s0, s1 = axis_y - slot / 2, axis_y + slot / 2
    upper = f"M{fmt(bx1 - arm)} {fmt(top)}H{fmt(bx1)}V{fmt(s0)}H{fmt(bx0)}V{fmt(top + bracket_w)}H{fmt(bx1 - arm)}Z"
    lower = f"M{fmt(bx0)} {fmt(s1)}H{fmt(bx1)}V{fmt(bot)}H{fmt(bx1 - arm)}V{fmt(bot - bracket_w)}H{fmt(bx0)}Z"
    ex0 = x0 + exact_cols0 * cw
    exact = f"M{fmt(ex0)} {fmt(axis_y - exact_h / 2)}H{fmt(exact_x1)}V{fmt(axis_y + exact_h / 2)}H{fmt(ex0)}Z"

    nl = chr(10)

    def block(rows):
        pad = indent + "     "
        return nl + nl.join(pad + r for r in rows) + nl + indent + "  "

    return nl.join([
        f"{indent}<!-- Code outside the context window: kept, dimmed, recoverable. -->",
        f'{indent}<path fill="{c_far}" d="{block(far)}"/>',
        f"{indent}<!-- Context held by the bracket. -->",
        f'{indent}<path fill="{c_near}" d="{block(near)}"/>',
        f"{indent}<!-- The bracket, with a slot sized for exactly one line. -->",
        f'{indent}<path fill="{c_bracket}" d="{upper}{lower}"/>',
        f"{indent}<!-- The exact line: passes through the slot and runs off the edge. -->",
        f'{indent}<path fill="{c_exact}" d="{exact}"/>',
    ])
