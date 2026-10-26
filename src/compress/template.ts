/**
 * Template normalization for grouping repeated lines: timestamps, UUIDs, hex
 * ids (>= 8 chars), numbers and progress bars become placeholders, and
 * whitespace runs collapse, so "Downloading 12.5MB/120MB" and
 * "Downloading 80.1MB/120MB" share one template.
 */

const NUM = '\u0000';
const BAR = '\u0001';

// Order matters: timestamps, UUIDs and hex ids before plain numbers, and times
// need word boundaries so "sha256:00fb…" is not read as the time "256:00".
const VOLATILE = new RegExp(
  [
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.source,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.source,
    /\b(?:0x)?(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/.source,
    /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\b/.source,
    /\d+(?:[.,]\d+)*/.source,
  ].join('|'),
  'gi',
);
const PROGRESS_BAR = /\[[=#>\-.*\s█▉▊▋▌▍▎▏░▒▓■□·]{2,}\]|[█▉▊▋▌▍▎▏░▒▓■□]{2,}|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g;
const SPACES = /[ \t]+/g;

export function templateOf(line: string): string {
  let t = line;
  if (/[[█▉▊▋▌▍▎▏░▒▓■□⠀-⣿]/.test(t)) t = t.replace(PROGRESS_BAR, BAR);
  return t.replace(VOLATILE, NUM).replace(SPACES, ' ').trim();
}

/** True when the template replaced a progress bar or spinner. */
export function templateHasBar(template: string): boolean {
  return template.includes(BAR);
}

/** Wording for how members of a template group differ. */
export function differenceWording(identical: boolean, template: string): string {
  if (identical) return 'identical';
  return templateHasBar(template)
    ? 'differing only in numbers/ids/timestamps/progress bars'
    : 'differing only in numbers/ids/timestamps';
}
