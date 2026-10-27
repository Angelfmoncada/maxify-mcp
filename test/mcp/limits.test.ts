import { describe, expect, it } from 'vitest';
import { MAX_BUDGET, MIN_BUDGET } from '../../src/engine/types.js';
import { MAX_TASK_CHARS } from '../../src/engine/validate.js';
import { MAX_NOTE_CHARS } from '../../src/memory/notes.js';
import { LIMITS, SINGLE_LINE_TEXT } from '../../src/mcp/limits.js';

describe('LIMITS mirror what the engine accepts', () => {
  it('uses the engine budget and task bounds', () => {
    expect(LIMITS.budget).toEqual({ min: MIN_BUDGET, max: MAX_BUDGET });
    expect(LIMITS.pageTokens).toEqual({ min: MIN_BUDGET, max: MAX_BUDGET });
    expect(LIMITS.taskChars).toBe(MAX_TASK_CHARS);
  });

  it('uses the engine note size', () => {
    expect(LIMITS.memoryTextChars).toBe(MAX_NOTE_CHARS);
  });

  it('keeps inline text far below the SDK frame cap even when every character needs a 6-byte escape', () => {
    const sdkFrameCap = 10 * 1024 * 1024;
    expect(LIMITS.textChars * 6).toBeLessThan(sdkFrameCap);
  });
});

describe('SINGLE_LINE_TEXT', () => {
  it.each(['plain note', 'uses jose@5 for JWTs', 'tab\tseparated', 'unicode: é中\u{1F600}', ''])(
    'accepts %j',
    (text) => {
      expect(SINGLE_LINE_TEXT.test(text)).toBe(true);
    },
  );

  it.each([
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['CRLF', 'a\r\nb'],
    ['vertical tab', 'a\u000bb'],
    ['form feed', 'a\u000cb'],
    ['escape', 'a\u001bb'],
    ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['NEL', 'a\u0085b'],
    ['line separator', `a${String.fromCharCode(0x2028)}b`],
    ['paragraph separator', `a${String.fromCharCode(0x2029)}b`],
  ])('rejects %s', (_name, text) => {
    expect(SINGLE_LINE_TEXT.test(text)).toBe(false);
  });
});
