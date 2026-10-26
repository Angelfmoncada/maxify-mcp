import { describe, expect, it } from 'vitest';
import { chunkLines, textAdapter } from '../../src/adapters/text.js';

const numbered = (count: number, blankAt: readonly number[] = []): string[] =>
  Array.from({ length: count }, (_, i) => (blankAt.includes(i + 1) ? '' : `line ${i + 1}`));

describe('text adapter: chunking', () => {
  it('splits into windows of at most 60 lines', () => {
    expect(chunkLines(numbered(130))).toEqual([
      { startLine: 1, endLine: 60 },
      { startLine: 61, endLine: 120 },
      { startLine: 121, endLine: 130 },
    ]);
  });

  it('prefers to end a window at a blank line within the last 15 lines', () => {
    expect(chunkLines(numbered(100, [50]))).toEqual([
      { startLine: 1, endLine: 50 },
      { startLine: 51, endLine: 100 },
    ]);
    expect(chunkLines(numbered(100, [40]))).toEqual([
      { startLine: 1, endLine: 60 },
      { startLine: 61, endLine: 100 },
    ]);
  });

  it('skips windows that contain only blank lines', () => {
    const lines = [...numbered(10), ...Array.from({ length: 130 }, () => ''), 'tail'];
    expect(chunkLines(lines)).toEqual([
      { startLine: 1, endLine: 60 },
      { startLine: 121, endLine: 141 },
    ]);
  });

  it('emits chunk symbols with line-range names and the first non-blank line as signature', () => {
    const text = ['', '  .button { color: red; }', ...numbered(70)].join('\n');
    const file = textAdapter.parse('styles/app.css', `${text}\n`);
    expect(file.language).toBe('css');
    expect(file.symbols.map((s) => [s.name, s.qualName, s.kind, s.span.startLine, s.span.endLine])).toEqual([
      ['L1-60', 'L1-60', 'chunk', 1, 60],
      ['L61-72', 'L61-72', 'chunk', 61, 72],
    ]);
    expect(file.symbols[0]?.signature).toBe('.button { color: red; }');
    expect(file.imports).toEqual([]);
    expect(file.refs).toEqual([]);
  });

  it('caps signatures at 100 characters and handles empty files', () => {
    const file = textAdapter.parse('notes.txt', 'z'.repeat(300));
    expect(file.symbols[0]?.signature.length).toBe(100);
    expect(textAdapter.parse('empty.py', '').symbols).toEqual([]);
  });

  it('counts CRLF line endings like LF', () => {
    const file = textAdapter.parse('run.sh', 'a\r\nb\r\nc\r\n');
    expect(file.symbols[0]?.span).toEqual({ startLine: 1, endLine: 3 });
  });
});
