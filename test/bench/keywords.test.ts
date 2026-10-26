import { describe, expect, it } from 'vitest';
import { MAX_KEYWORDS, extractKeywords, identifierParts, stem } from '../../src/bench/keywords.js';

describe('identifierParts', () => {
  it('splits camelCase, PascalCase, snake_case and SCREAMING_CASE', () => {
    expect(identifierParts('verifyToken')).toEqual(['verify', 'token']);
    expect(identifierParts('TaskService')).toEqual(['task', 'service']);
    expect(identifierParts('DEFAULT_PAGE_SIZE')).toEqual(['default', 'page', 'size']);
    expect(identifierParts('parseHTTPResponse')).toEqual(['parse', 'http', 'response']);
  });

  it('drops parts shorter than three characters', () => {
    expect(identifierParts('isOk')).toEqual([]);
    expect(identifierParts('getIdByName')).toEqual(['get', 'name']);
  });
});

describe('stem', () => {
  it('maps inflections of one word to a shared stem', () => {
    expect(stem('expires')).toBe('expir');
    expect(stem('expired')).toBe('expir');
    expect(stem('tasks')).toBe('task');
    expect(stem('priorities')).toBe('priority');
  });

  it('never shortens a word below four characters or strips double s', () => {
    expect(stem('uses')).toBe('uses');
    expect(stem('class')).toBe('class');
    expect(stem('does')).toBe('does');
  });
});

describe('extractKeywords', () => {
  it('lists quoted strings first, then identifiers, then their parts, then plain words', () => {
    const keywords = extractKeywords('Why does `verifyToken` reject the "Authorization header is missing" message when sessions expire');
    expect(keywords.indexOf('authorization header is missing')).toBeGreaterThanOrEqual(0);
    expect(keywords.indexOf('verifytoken')).toBeGreaterThan(keywords.indexOf('authorization header is missing'));
    expect(keywords.indexOf('verify')).toBeGreaterThan(keywords.indexOf('verifytoken'));
    expect(keywords).toContain('token');
    expect(keywords.indexOf('session')).toBeGreaterThan(keywords.indexOf('token'));
  });

  it('skips stopwords, short words and numbers', () => {
    const keywords = extractKeywords('Please explain where the 25 tasks are shown and what that means');
    expect(keywords).toContain('task');
    for (const stopword of ['please', 'explain', 'where', 'what', 'that']) expect(keywords).not.toContain(stopword);
    expect(keywords).not.toContain('25');
    expect(keywords.every((keyword) => keyword.length >= 3)).toBe(true);
  });

  it('turns paths into the full path plus the parts of each segment', () => {
    const keywords = extractKeywords('look at src/server/auth/token.ts for the expiry check');
    expect(keywords).toContain('src/server/auth/token.ts');
    expect(keywords).toContain('server');
    expect(keywords).toContain('auth');
    expect(keywords).toContain('token');
  });

  it('does not treat apostrophes in prose as quotes', () => {
    const keywords = extractKeywords("the user's token isn't refreshed");
    expect(keywords.some((keyword) => keyword.includes("s token isn"))).toBe(false);
    expect(keywords).toContain('token');
  });

  it('caps the list and is deterministic', () => {
    const prompt =
      'alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega alphaBeta gammaDelta thetaIota kappaLambda';
    const first = extractKeywords(prompt);
    expect(first.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    expect(extractKeywords(prompt)).toEqual(first);
    expect(extractKeywords(prompt, 3)).toHaveLength(3);
    expect(extractKeywords('', 5)).toEqual([]);
  });

  it('removes duplicates', () => {
    const keywords = extractKeywords('token token Token tokens');
    expect(keywords.filter((keyword) => keyword === 'token')).toHaveLength(1);
  });
});
