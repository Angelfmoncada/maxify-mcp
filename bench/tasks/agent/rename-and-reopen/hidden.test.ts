import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.ts';
import type { App } from '../src/server/app.ts';
import { TaskService } from '../src/server/tasks/service.ts';
import { silentLogger } from '../src/server/util/logger.ts';

const PASSWORD = 'correct-horse-battery';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_NAME = 'updateStatus';

interface Account {
  id: string;
  headers: Record<string, string>;
}

async function register(app: App, email: string): Promise<Account> {
  const response = await app.handle({ method: 'POST', url: '/auth/register', body: { email, name: email, password: PASSWORD } });
  assert.equal(response.status, 201);
  const body = response.body as { token: string; user: { id: string } };
  return { id: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|md|json|cjs)$/.test(entry.name) && entry.name !== 'hidden.test.ts') out.push(full);
  }
  return out;
}

describe('rename of updateStatus to changeStatus', () => {
  it('exposes changeStatus and no longer exposes updateStatus', () => {
    const prototype = TaskService.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof prototype.changeStatus, 'function');
    assert.equal(typeof prototype[OLD_NAME], 'undefined');
  });

  it('leaves no mention of the old name in source, tests or docs', () => {
    const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'test')), ...sourceFiles(path.join(ROOT, 'docs')), path.join(ROOT, 'README.md')];
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(OLD_NAME)).map((file) => path.relative(ROOT, file));
    assert.deepEqual(offenders, []);
  });
});

describe('reopen', () => {
  async function world() {
    const app = createApp({ env: { NODE_ENV: 'test' }, config: { tokenSecret: 'hidden-secret-0123456789' }, logger: silentLogger });
    const admin = await register(app, 'admin@example.com');
    const owner = await register(app, 'owner@example.com');
    const stranger = await register(app, 'stranger@example.com');
    const viewer = await register(app, 'viewer@example.com');
    await app.handle({ method: 'PATCH', url: `/users/${viewer.id}/role`, headers: admin.headers, body: { role: 'viewer' } });
    const relogin = await app.handle({ method: 'POST', url: '/auth/login', body: { email: 'viewer@example.com', password: PASSWORD } });
    viewer.headers = { authorization: `Bearer ${(relogin.body as { token: string }).token}` };
    const created = await app.handle({ method: 'POST', url: '/tasks', headers: owner.headers, body: { title: 'Reopen me' } });
    const id = (created.body as { id: string }).id;
    const move = (status: string) => app.handle({ method: 'POST', url: `/tasks/${id}/status`, headers: owner.headers, body: { status } });
    const reopen = (headers: Record<string, string>, target: string = id) => app.handle({ method: 'POST', url: `/tasks/${target}/reopen`, headers });
    return { app, admin, owner, stranger, viewer, id, move, reopen };
  }

  async function finish(w: Awaited<ReturnType<typeof world>>): Promise<void> {
    assert.equal((await w.move('in_progress')).status, 200);
    assert.equal((await w.move('done')).status, 200);
  }

  it('moves a done task back to in_progress for its owner', async () => {
    const w = await world();
    await finish(w);
    const response = await w.reopen(w.owner.headers);
    assert.equal(response.status, 200);
    assert.equal((response.body as { status: string }).status, 'in_progress');
  });

  it('answers 409 when the task is not done', async () => {
    const w = await world();
    assert.equal((await w.reopen(w.owner.headers)).status, 409);
    assert.equal((await w.move('in_progress')).status, 200);
    assert.equal((await w.reopen(w.owner.headers)).status, 409);
  });

  it('keeps the ownership rules: admins may, strangers and viewers may not', async () => {
    const w = await world();
    await finish(w);
    assert.equal((await w.reopen(w.stranger.headers)).status, 403);
    assert.equal((await w.reopen(w.viewer.headers)).status, 403);
    assert.equal((await w.reopen(w.admin.headers)).status, 200);
  });

  it('answers 404 for an unknown task and 401 without a token', async () => {
    const w = await world();
    assert.equal((await w.reopen(w.owner.headers, 'task_missing')).status, 404);
    assert.equal((await w.reopen({})).status, 401);
  });

  it('is implemented on top of changeStatus', async () => {
    const w = await world();
    await finish(w);
    const service = w.app.services.tasks as unknown as { changeStatus: (...args: unknown[]) => unknown };
    const original = service.changeStatus.bind(service);
    let calls = 0;
    service.changeStatus = (...args: unknown[]) => {
      calls += 1;
      return original(...args);
    };
    assert.equal((await w.reopen(w.owner.headers)).status, 200);
    assert.equal(calls, 1);
  });
});
