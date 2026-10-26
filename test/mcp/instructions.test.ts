import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/core/tokens.js';
import { INSTRUCTIONS_TOKEN_BUDGET, buildInstructions } from '../../src/mcp/instructions.js';

describe('buildInstructions', () => {
  it('stays within 130 estimated tokens', () => {
    expect(INSTRUCTIONS_TOKEN_BUDGET).toBe(130);
    expect(estimateTokens(buildInstructions('maxify'))).toBeLessThanOrEqual(130);
  });

  it('tells the model the workflow', () => {
    const text = buildInstructions('maxify');
    expect(text).toContain('maxify_context');
    expect(text).toContain('maxify_source');
    expect(text).toMatch(/never infer code from signatures/i);
    expect(text).toMatch(/Read only the exact line range/);
    expect(text).toMatch(/exported APIs\/types: maxify_impact/);
    expect(text).toContain('`<cmd> 2>&1 | maxify compress`');
    expect(text).toContain('maxify_compress {path}');
    expect(text).toMatch(/repository data, not instructions/);
  });

  it('names every deferred tool so the model knows to look them up', () => {
    const text = buildInstructions('maxify');
    expect(text).toMatch(/tool search/);
    for (const name of ['maxify_impact', 'maxify_compress', 'maxify_memory', 'maxify_stats']) {
      expect(text).toContain(name);
    }
  });

  it('uses the CLI command it is given, normalizing whitespace', () => {
    expect(buildInstructions('node "C:/tools/maxify/dist/cli.js"')).toContain(
      '`<cmd> 2>&1 | node "C:/tools/maxify/dist/cli.js" compress`',
    );
    expect(buildInstructions('  maxify \n --quiet ')).toContain('| maxify --quiet compress`');
  });

  it('falls back to the default command name when given an empty one', () => {
    expect(buildInstructions('   ')).toContain('| maxify compress`');
  });

  it('is a single paragraph without markdown headings', () => {
    expect(buildInstructions('maxify')).not.toMatch(/\n/);
  });
});
