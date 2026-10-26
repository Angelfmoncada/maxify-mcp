/**
 * Budget filling for grouped layouts (search results, listings): starting
 * from the most compact settings that fit, each round upgrades the largest
 * prefix of groups (document order) that still fits. Deterministic, and
 * O(rounds × log(groups)) renders.
 */
export interface Progressive<S> {
  settings: S[];
  text: string;
}

export function progressive<S>(
  initial: readonly S[],
  rounds: ReadonlyArray<(s: S) => S>,
  render: (settings: readonly S[]) => string,
  fits: (text: string) => boolean,
): Progressive<S> {
  let settings = [...initial];
  let text = render(settings);
  for (const upgrade of rounds) {
    let lo = 1;
    let hi = settings.length;
    let bestK = 0;
    let bestText = text;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const trial = settings.map((s, k) => (k < mid ? upgrade(s) : s));
      const t = render(trial);
      if (fits(t)) {
        bestK = mid;
        bestText = t;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestK > 0) {
      settings = settings.map((s, k) => (k < bestK ? upgrade(s) : s));
      text = bestText;
    }
  }
  return { settings, text };
}

/** Largest n in [0, max] with fits(render(n)); assumes larger n renders longer. */
export function largestFitting(max: number, render: (n: number) => string, fits: (text: string) => boolean): { n: number; text: string } {
  let best = { n: 0, text: render(0) };
  let lo = 1;
  let hi = max;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = render(mid);
    if (fits(t)) {
      best = { n: mid, text: t };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
