/** Terminal-safe rendering of text that may come from a repository (file names, config values). */

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Replace control characters (ESC, BEL, ...) with visible \xNN escapes so they cannot drive the terminal. */
export function visible(text: string): string {
  return text.replace(CONTROL_CHARS, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
