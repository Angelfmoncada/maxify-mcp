import { describe, expect, it } from 'vitest';
import { visible } from '../../src/cli/text.js';

describe('visible', () => {
  it('leaves ordinary text, tabs and newlines alone', () => {
    expect(visible('plain text\twith tab\nand newline')).toBe('plain text\twith tab\nand newline');
    expect(visible('unicode: é中\u{1F600}')).toBe('unicode: é中\u{1F600}');
  });

  it('turns terminal control characters into visible escapes', () => {
    expect(visible('\u001b[31mred\u001b[0m')).toBe('\\x1b[31mred\\x1b[0m');
    expect(visible('bell\u0007')).toBe('bell\\x07');
    expect(visible('nul\u0000')).toBe('nul\\x00');
    expect(visible('del\u007f')).toBe('del\\x7f');
    expect(visible('c1\u009b')).toBe('c1\\x9b');
    expect(visible('cr\rrewrite')).toBe('cr\\x0drewrite');
  });
});
