import { describe, expect, it } from 'vitest';
import {
  forbiddenHits,
  forbiddenMentions,
  isSatisfied,
  resolveRequirement,
  scoreRecall,
  unionCovers,
  type Evidence,
} from '../../src/bench/scoring.js';
import type { RequirementSpec } from '../../src/bench/offline-types.js';

const FILE = [
  'export class Service {', // 1
  '  update(id: string): number {', // 2
  '    const found = id.length;', // 3
  '    return found;', // 4
  '  }', // 5
  '',
  '  remove(id: string): void {', // 7
  '    void id;', // 8
  '  }', // 9
  '}', // 10
  '',
].join('\n');

const files = new Map([
  ['src/service.ts', FILE],
  ['src/other.ts', 'export const x = 1;\n'],
  ['src/legacy/old.ts', 'export const y = 2;\n'],
]);

const req = (ref: string, level: RequirementSpec['level']) => resolveRequirement({ ref, level }, files);
const item = (start: number, end: number, level: Evidence['level'], symbol?: string, path = 'src/service.ts'): Evidence => ({
  path,
  startLine: start,
  endLine: end,
  level,
  ...(symbol === undefined ? {} : { symbol }),
});

describe('resolveRequirement', () => {
  it('locates files, symbols and ranges, and explains failures', () => {
    expect(req('src/service.ts', 'map').span).toEqual({ startLine: 1, endLine: 10 });
    expect(req('src/service.ts#Service.update', 'source').span).toEqual({ startLine: 2, endLine: 5 });
    expect(req('src/service.ts:3-4', 'source').span).toEqual({ startLine: 3, endLine: 4 });
    expect(req('src/missing.ts', 'map').problem).toMatch(/does not exist/);
    expect(req('src/service.ts#Service.nope', 'map').problem).toMatch(/not found/);
    expect(req('src/service.ts:5-99', 'map').problem).toMatch(/past line/);
  });
});

describe('unionCovers', () => {
  it('merges overlapping and adjacent pieces', () => {
    expect(unionCovers([{ startLine: 1, endLine: 5 }, { startLine: 6, endLine: 9 }], { startLine: 3, endLine: 8 })).toBe(true);
    expect(unionCovers([{ startLine: 1, endLine: 4 }, { startLine: 6, endLine: 9 }], { startLine: 3, endLine: 8 })).toBe(false);
  });
});

describe('isSatisfied', () => {
  it('needs the whole symbol inside source-level evidence for source requirements', () => {
    const requirement = req('src/service.ts#Service.update', 'source');
    expect(isSatisfied(requirement, [item(2, 5, 'source')])).toBe(true);
    expect(isSatisfied(requirement, [item(1, 10, 'source', 'Service')])).toBe(true);
    expect(isSatisfied(requirement, [item(2, 3, 'source'), item(4, 5, 'source')])).toBe(true);
    expect(isSatisfied(requirement, [item(2, 4, 'source')])).toBe(false);
    expect(isSatisfied(requirement, [item(2, 5, 'signature', 'Service.update')])).toBe(false);
  });

  it('accepts a named or enclosing item for signature requirements, at signature level or higher', () => {
    const requirement = req('src/service.ts#Service.remove', 'signature');
    expect(isSatisfied(requirement, [item(7, 9, 'signature', 'Service.remove')])).toBe(true);
    expect(isSatisfied(requirement, [item(1, 10, 'signature', 'Service')])).toBe(true);
    expect(isSatisfied(requirement, [item(7, 9, 'source')])).toBe(true);
    expect(isSatisfied(requirement, [item(1, 10, 'map')])).toBe(false);
    expect(isSatisfied(requirement, [item(2, 5, 'signature', 'Service.update')])).toBe(false);
  });

  it('accepts any evidence naming or containing the symbol for map requirements', () => {
    const requirement = req('src/service.ts#Service.remove', 'map');
    expect(isSatisfied(requirement, [item(1, 10, 'map')])).toBe(true);
    expect(isSatisfied(requirement, [item(7, 7, 'map', 'Service.remove')])).toBe(true);
    expect(isSatisfied(requirement, [item(1, 1, 'map')])).toBe(false);
  });

  it('handles file requirements at each level', () => {
    expect(isSatisfied(req('src/other.ts', 'map'), [item(1, 1, 'map', undefined, 'src/other.ts')])).toBe(true);
    expect(isSatisfied(req('src/other.ts', 'signature'), [item(1, 1, 'map', undefined, 'src/other.ts')])).toBe(false);
    expect(isSatisfied(req('src/service.ts', 'source'), [item(1, 6, 'source'), item(7, 10, 'source')])).toBe(true);
    expect(isSatisfied(req('src/service.ts', 'source'), [item(1, 6, 'source')])).toBe(false);
  });

  it('handles range requirements: overlap below source level, containment at source level', () => {
    expect(isSatisfied(req('src/service.ts:3-4', 'signature'), [item(4, 8, 'signature')])).toBe(true);
    expect(isSatisfied(req('src/service.ts:3-4', 'signature'), [item(6, 8, 'signature')])).toBe(false);
    expect(isSatisfied(req('src/service.ts:3-4', 'source'), [item(3, 5, 'source')])).toBe(true);
    expect(isSatisfied(req('src/service.ts:3-4', 'source'), [item(4, 5, 'source')])).toBe(false);
  });

  it('never treats an unresolved requirement as satisfied and ignores other files', () => {
    expect(isSatisfied(req('src/missing.ts', 'map'), [item(1, 1, 'source')])).toBe(false);
    expect(isSatisfied(req('src/service.ts#Service.update', 'map'), [item(1, 10, 'source', undefined, 'src/other.ts')])).toBe(false);
  });
});

describe('scoreRecall', () => {
  it('reports the satisfied and missed refs and the fraction', () => {
    const requirements = [req('src/service.ts#Service.update', 'source'), req('src/service.ts#Service.remove', 'source')];
    const result = scoreRecall(requirements, [item(2, 5, 'source')]);
    expect(result.recall).toBe(0.5);
    expect(result.satisfied).toEqual(['src/service.ts#Service.update']);
    expect(result.missed).toEqual(['src/service.ts#Service.remove']);
  });

  it('counts an empty requirement list as full recall', () => {
    expect(scoreRecall([], []).recall).toBe(1);
  });
});

describe('forbiddenHits', () => {
  const evidence = [item(1, 1, 'map', undefined, 'src/legacy/old.ts'), item(2, 5, 'signature', 'Service.update')];

  it('matches files, directories, symbols and ranges', () => {
    expect(forbiddenHits(['src/legacy/old.ts'], evidence)).toEqual(['src/legacy/old.ts']);
    expect(forbiddenHits(['src/legacy/'], evidence)).toEqual(['src/legacy/']);
    expect(forbiddenHits(['src/service.ts#Service.update'], evidence)).toEqual(['src/service.ts#Service.update']);
    expect(forbiddenHits(['src/service.ts#Service'], [item(1, 10, 'map', 'Service.remove')])).toEqual(['src/service.ts#Service']);
    expect(forbiddenHits(['src/service.ts:8-9'], evidence)).toEqual([]);
    expect(forbiddenHits(['src/service.ts:3-9'], evidence)).toEqual(['src/service.ts:3-9']);
  });

  it('does not report decoys that are absent', () => {
    expect(forbiddenHits(['src/other.ts'], evidence)).toEqual([]);
  });
});

describe('forbiddenMentions', () => {
  it('finds forbidden paths anywhere in the text', () => {
    expect(forbiddenMentions(['src/legacy/old.ts', 'src/other.ts'], 'see src/legacy/old.ts:3 for details')).toEqual(['src/legacy/old.ts']);
  });
});
