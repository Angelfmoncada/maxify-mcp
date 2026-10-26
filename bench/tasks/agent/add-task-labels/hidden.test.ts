import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';
import type { App } from '../src/server/app.ts';
import { silentLogger } from '../src/server/util/logger.ts';
import { ValidationError, validateTaskInput, validateTaskPatch } from '../src/shared/validation.ts';

function issueFields(action: () => unknown): string[] {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ValidationError) return error.issues.map((issue) => issue.field);
    throw error;
  }
  return [];
}

async function setup(): Promise<{ app: App; headers: Record<string, string> }> {
  const app = createApp({ env: { NODE_ENV: 'test' }, config: { tokenSecret: 'hidden-secret-0123456789' }, logger: silentLogger });
  const response = await app.handle({
    method: 'POST',
    url: '/auth/register',
    body: { email: 'labels@example.com', name: 'Labels', password: 'correct-horse-battery' },
  });
  assert.equal(response.status, 201);
  return { app, headers: { authorization: `Bearer ${(response.body as { token: string }).token}` } };
}

describe('label validation', () => {
  it('trims, lower-cases and de-duplicates while keeping the first occurrence order', () => {
    const input = validateTaskInput({ title: 'Plan', labels: [' Bug ', 'bug', 'URGENT', 'Bug'] });
    assert.deepEqual(input.labels, ['bug', 'urgent']);
  });

  it('accepts exactly five distinct labels and 24-character labels', () => {
    assert.equal(validateTaskInput({ title: 'Plan', labels: ['a', 'b', 'c', 'd', 'e'] }).labels?.length, 5);
    assert.equal(validateTaskInput({ title: 'Plan', labels: ['x'.repeat(24)] }).labels?.length, 1);
  });

  it('counts distinct labels after normalization, not before', () => {
    const input = validateTaskInput({ title: 'Plan', labels: ['a', 'A', 'b', 'B', 'c', 'd', 'e'] });
    assert.deepEqual(input.labels, ['a', 'b', 'c', 'd', 'e']);
  });

  it('reports violations on the labels field', () => {
    assert.deepEqual(issueFields(() => validateTaskInput({ title: 'Plan', labels: 'bug' })), ['labels']);
    assert.deepEqual(issueFields(() => validateTaskInput({ title: 'Plan', labels: ['ok', 7] })), ['labels']);
    assert.deepEqual(issueFields(() => validateTaskInput({ title: 'Plan', labels: ['ok', '   '] })), ['labels']);
    assert.deepEqual(issueFields(() => validateTaskInput({ title: 'Plan', labels: ['x'.repeat(25)] })), ['labels']);
    assert.deepEqual(issueFields(() => validateTaskInput({ title: 'Plan', labels: ['a', 'b', 'c', 'd', 'e', 'f'] })), ['labels']);
  });

  it('validates labels in patches as well', () => {
    assert.deepEqual(validateTaskPatch({ labels: [' Docs '] }).labels, ['docs']);
    assert.deepEqual(issueFields(() => validateTaskPatch({ labels: 'docs' })), ['labels']);
    assert.deepEqual(issueFields(() => validateTaskPatch({})), ['body']);
  });
});

describe('labels through the API', () => {
  it('stores labels on create and returns [] when none are given', async () => {
    const { app, headers } = await setup();
    const withLabels = await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'One', labels: ['Bug', ' bug ', 'Backend'] } });
    assert.equal(withLabels.status, 201);
    assert.deepEqual((withLabels.body as { labels: string[] }).labels, ['bug', 'backend']);
    const without = await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Two' } });
    assert.deepEqual((without.body as { labels: string[] }).labels, []);
  });

  it('keeps labels on a patch that omits them and clears them with an empty list', async () => {
    const { app, headers } = await setup();
    const created = await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Patch me', labels: ['a', 'b'] } });
    const id = (created.body as { id: string }).id;

    const renamed = await app.handle({ method: 'PATCH', url: `/tasks/${id}`, headers, body: { title: 'Patched' } });
    assert.equal(renamed.status, 200);
    assert.deepEqual((renamed.body as { labels: string[] }).labels, ['a', 'b']);

    const relabelled = await app.handle({ method: 'PATCH', url: `/tasks/${id}`, headers, body: { labels: ['C'] } });
    assert.deepEqual((relabelled.body as { labels: string[] }).labels, ['c']);

    const cleared = await app.handle({ method: 'PATCH', url: `/tasks/${id}`, headers, body: { labels: [] } });
    assert.deepEqual((cleared.body as { labels: string[] }).labels, []);

    const fetched = await app.handle({ method: 'GET', url: `/tasks/${id}`, headers });
    assert.deepEqual((fetched.body as { labels: string[] }).labels, []);
  });

  it('answers 400 and names the field for invalid labels', async () => {
    const { app, headers } = await setup();
    const response = await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Bad', labels: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /labels/);
  });

  it('exports labels as the last CSV column, joined with a pipe', async () => {
    const { app, headers } = await setup();
    await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Exported', labels: ['bug', 'urgent'] } });
    await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Plain' } });
    const response = await app.handle({ method: 'GET', url: '/tasks/export.csv', headers });
    assert.equal(response.status, 200);
    const lines = String(response.body).trim().split('\r\n');
    assert.ok((lines[0] ?? '').endsWith(',labels'));
    assert.ok((lines[1] ?? '').endsWith(',bug|urgent'));
    assert.equal((lines[2] ?? '').split(',').length, (lines[0] ?? '').split(',').length);
  });
});
