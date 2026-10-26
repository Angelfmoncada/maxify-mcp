import { describe, expect, it } from 'vitest';
import { markdownAdapter } from '../../src/adapters/markdown.js';
import { src } from './helpers.js';

const parse = (text: string, path = 'docs/guide.md') => markdownAdapter.parse(path, text);

describe('markdown adapter: sections', () => {
  const file = parse(
    src(
      '---', // 1
      'title: Guide', // 2
      '# Not a heading', // 3
      '---', // 4
      '# Guide', // 5
      '', // 6
      'Intro paragraph that', // 7
      'spans two lines.', // 8
      '', // 9
      '## Install ##', // 10
      '```bash', // 11
      '# not a heading either', // 12
      'npm i maxify', // 13
      '```', // 14
      '', // 15
      'Run the [CLI](./cli.md#usage) after installing.', // 16
      '### Options', // 17
      'Flags.', // 18
      '## Usage', // 19
      'Setext title', // 20
      '============', // 21
      'Body.', // 22
      '', // 23
      'Second level', // 24
      '------------', // 25
      '## Usage', // 26
    ),
  );

  it('creates nested sections for ATX and setext headings outside code', () => {
    expect(file.symbols.map((s) => [s.qualName, s.span.startLine, s.span.endLine, s.parent])).toEqual([
      ['Guide', 5, 19, null],
      ['Guide > Install', 10, 18, 0],
      ['Guide > Install > Options', 17, 18, 1],
      ['Guide > Usage', 19, 19, 0],
      ['Setext title', 20, 26, null],
      ['Setext title > Second level', 24, 25, 4],
      ['Setext title > Usage', 26, 26, 4],
    ]);
  });

  it('fills kind, signature, doc and level flag', () => {
    expect(file.symbols[0]).toEqual({
      name: 'Guide',
      qualName: 'Guide',
      kind: 'section',
      span: { startLine: 5, endLine: 19 },
      exported: false,
      exportNames: [],
      signature: 'Guide',
      doc: 'Intro paragraph that spans two lines.',
      parent: null,
      flags: ['h1'],
    });
    expect(file.symbols[1]?.name).toBe('Install');
    expect(file.symbols[1]?.signature).toBe('Guide > Install');
    expect(file.symbols[1]?.doc).toBe('Run the [CLI](./cli.md#usage) after installing.');
    expect(file.symbols[4]?.flags).toEqual(['h1']);
    expect(file.symbols[5]?.flags).toEqual(['h2']);
  });

  it('de-duplicates repeated heading paths', () => {
    const dup = parse(src('# A', '## B', '## B', '# A'));
    expect(dup.symbols.map((s) => s.qualName)).toEqual(['A', 'A > B', 'A > B~2', 'A~2']);
  });

  it('strips inline markup from heading names and caps docs at 300 characters', () => {
    const marked = parse(src('## The `maxify_context` **tool** and [docs](./d.md)', '', 'x'.repeat(400)));
    expect(marked.symbols[0]?.name).toBe('The maxify_context tool and docs');
    expect(marked.symbols[0]?.doc.length).toBeLessThanOrEqual(300);
  });

  it('does not treat list continuations or thematic breaks as setext headings', () => {
    const tricky = parse(src('# Top', '- item', '  continued', '---', '', '***', 'text'));
    expect(tricky.symbols.map((s) => s.qualName)).toEqual(['Top']);
  });

  it('handles empty files and files without headings', () => {
    expect(parse('').symbols).toEqual([]);
    expect(parse('just text').symbols).toEqual([]);
  });
});

describe('markdown adapter: links', () => {
  it('imports relative link targets without anchors or queries, once each', () => {
    const file = parse(
      src(
        'See [setup](./setup.md), [code](../src/foo.ts#L3) and ![diagram](img/arch.png "Arch").',
        'Also [setup again](./setup.md?plain=1) and [site](https://example.com) or [mail](mailto:a@b.c).',
        '[anchor](#install) [abs](/docs/x.md) [proto](//cdn.example.com/x.js) [angle](<./with space.md>)',
        'Inline `[not](./code.md)` is ignored.',
        '```',
        '[fenced](./fenced.md)',
        '```',
        '[ref]: ./reference.md "Title"',
      ),
    );
    expect(file.imports).toEqual([
      { spec: './setup.md', kind: 'import', bindings: [], line: 1 },
      { spec: '../src/foo.ts', kind: 'import', bindings: [], line: 1 },
      { spec: 'img/arch.png', kind: 'import', bindings: [], line: 1 },
      { spec: './with space.md', kind: 'import', bindings: [], line: 3 },
      { spec: './reference.md', kind: 'import', bindings: [], line: 8 },
    ]);
    expect(file.refs).toEqual([]);
    expect(file.language).toBe('markdown');
  });

  it('reads ESM imports in MDX files', () => {
    const file = parse(src("import { Chart } from '../components/Chart';", "import './styles.css';", '# Title', '<Chart />'), 'docs/page.mdx');
    expect(file.language).toBe('mdx');
    expect(file.imports.map((i) => i.spec)).toEqual(['../components/Chart', './styles.css']);
    expect(file.symbols.map((s) => s.qualName)).toEqual(['Title']);
  });
});
