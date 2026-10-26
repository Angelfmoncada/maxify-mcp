import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/core/tokens.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { createNoopEngine, describeToolSurface, formatSurface } from '../../src/mcp/surface.js';
import { TOOL_NAMES } from '../../src/mcp/tools.js';

describe('describeToolSurface', () => {
  it('reports instructions and each tool as a real client sees them', async () => {
    const surface = await describeToolSurface();
    expect(surface.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(surface.instructionsTokens).toBe(estimateTokens(buildInstructions('maxify')));
    for (const tool of surface.tools) expect(tool.tokens, tool.name).toBeGreaterThan(50);
    const toolSum = surface.tools.reduce((sum, tool) => sum + tool.tokens, 0);
    expect(surface.totalTokens).toBe(surface.instructionsTokens + toolSum);
  });

  it('stays small enough to be worth loading on every session', async () => {
    const surface = await describeToolSurface();
    expect(surface.totalTokens).toBeLessThan(2500);
    expect(surface.instructionsTokens).toBeLessThanOrEqual(130);
  });

  it('computes the upfront cost when the client defers non-essential tools', async () => {
    const surface = await describeToolSurface();
    const alwaysLoaded = surface.tools.filter((tool) => tool.alwaysLoad).map((tool) => tool.name);
    expect(alwaysLoaded.sort()).toEqual(['maxify_context', 'maxify_source']);
    expect(surface.upfrontTokens).toBeLessThan(surface.totalTokens);
    const loaded = surface.tools.filter((tool) => tool.alwaysLoad).reduce((sum, tool) => sum + tool.tokens, 0);
    expect(surface.upfrontTokens).toBeGreaterThanOrEqual(surface.instructionsTokens + loaded);
  });

  it('reflects the CLI command embedded in the instructions', async () => {
    const short = await describeToolSurface({ cliCommand: 'maxify' });
    const long = await describeToolSurface({ cliCommand: 'node "C:/a/very/long/path/to/maxify/dist/cli.js"' });
    expect(long.instructionsTokens).toBeGreaterThan(short.instructionsTokens);
  });

  it('formats a one-line summary', async () => {
    const surface = await describeToolSurface();
    const line = formatSurface(surface);
    expect(line).not.toContain('\n');
    expect(line).toContain(String(surface.totalTokens));
    expect(line).toContain(String(surface.upfrontTokens));
    expect(line).toContain('maxify_context');
  });
});

describe('createNoopEngine', () => {
  it('answers every call with empty output', async () => {
    const engine = createNoopEngine();
    expect((await engine.context({ task: 'x' })).text).toBe('');
    expect((await engine.source({ ref: 'x' })).text).toBe('');
    expect((await engine.impact({ targets: ['x'] })).text).toBe('');
    expect((await engine.compress({ text: 'x' })).text).toBe('');
    expect((await engine.memory({ op: 'list' })).text).toBe('');
    expect((await engine.stats()).text).toBe('');
    expect((await engine.index()).errors).toEqual([]);
    expect(() => engine.close()).not.toThrow();
  });
});
