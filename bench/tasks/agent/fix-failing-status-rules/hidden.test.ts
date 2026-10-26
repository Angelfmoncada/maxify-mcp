import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';
import type { App } from '../src/server/app.ts';
import { silentLogger } from '../src/server/util/logger.ts';

const PASSWORD = 'correct-horse-battery';

async function signUp(app: App, email: string): Promise<{ headers: Record<string, string>; id: string }> {
  const response = await app.handle({
    method: 'POST',
    url: '/auth/register',
    body: { email, name: 'Hidden Test', password: PASSWORD },
  });
  assert.equal(response.status, 201);
  const body = response.body as { token: string; user: { id: string } };
  return { headers: { authorization: `Bearer ${body.token}` }, id: body.user.id };
}

async function createTask(app: App, headers: Record<string, string>): Promise<string> {
  const response = await app.handle({ method: 'POST', url: '/tasks', headers, body: { title: 'Board rules' } });
  assert.equal(response.status, 201);
  return (response.body as { id: string }).id;
}

function move(app: App, headers: Record<string, string>, id: string, status: string): Promise<{ status: number }> {
  return app.handle({ method: 'POST', url: `/tasks/${id}/status`, headers, body: { status } });
}

function newApp(): App {
  return createApp({ env: { NODE_ENV: 'test' }, config: { tokenSecret: 'hidden-secret-0123456789' }, logger: silentLogger });
}

describe('status transitions are enforced for every role', () => {
  it('rejects a skipped column for admins', async () => {
    const app = newApp();
    const admin = await signUp(app, 'admin@example.com');
    const id = await createTask(app, admin.headers);
    assert.equal((await move(app, admin.headers, id, 'in_review')).status, 409);
    assert.equal((await move(app, admin.headers, id, 'done')).status, 409);
  });

  it('lets an admin walk the allowed path and rejects an illegal reopen', async () => {
    const app = newApp();
    const admin = await signUp(app, 'admin@example.com');
    const id = await createTask(app, admin.headers);
    assert.equal((await move(app, admin.headers, id, 'in_progress')).status, 200);
    assert.equal((await move(app, admin.headers, id, 'done')).status, 200);
    assert.equal((await move(app, admin.headers, id, 'todo')).status, 409);
    assert.equal((await move(app, admin.headers, id, 'in_progress')).status, 200);
  });

  it('applies the same rules to a member who owns the task', async () => {
    const app = newApp();
    await signUp(app, 'admin@example.com');
    const member = await signUp(app, 'member@example.com');
    const id = await createTask(app, member.headers);
    assert.equal((await move(app, member.headers, id, 'done')).status, 409);
    assert.equal((await move(app, member.headers, id, 'in_progress')).status, 200);
  });

  it('still answers 403 before 409 when a stranger tries an illegal move', async () => {
    const app = newApp();
    await signUp(app, 'admin@example.com');
    const owner = await signUp(app, 'owner@example.com');
    const stranger = await signUp(app, 'stranger@example.com');
    const id = await createTask(app, owner.headers);
    assert.equal((await move(app, stranger.headers, id, 'done')).status, 403);
  });
});
