import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';
import type { App } from '../src/server/app.ts';
import type { TaskEvent } from '../src/server/tasks/events.ts';
import { silentLogger } from '../src/server/util/logger.ts';

const PASSWORD = 'correct-horse-battery';

interface Account {
  id: string;
  headers: Record<string, string>;
}

interface TaskBody {
  id: string;
  assigneeId: string | null;
}

async function register(app: App, email: string): Promise<Account> {
  const response = await app.handle({ method: 'POST', url: '/auth/register', body: { email, name: email, password: PASSWORD } });
  assert.equal(response.status, 201);
  const body = response.body as { token: string; user: { id: string } };
  return { id: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

async function login(app: App, email: string): Promise<Record<string, string>> {
  const response = await app.handle({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(response.status, 200);
  return { authorization: `Bearer ${(response.body as { token: string }).token}` };
}

interface World {
  app: App;
  admin: Account;
  owner: Account;
  teammate: Account;
  viewer: Account;
  taskId: string;
  events: TaskEvent[];
}

async function world(): Promise<World> {
  const app = createApp({ env: { NODE_ENV: 'test' }, config: { tokenSecret: 'hidden-secret-0123456789' }, logger: silentLogger });
  const admin = await register(app, 'admin@example.com');
  const owner = await register(app, 'owner@example.com');
  const teammate = await register(app, 'teammate@example.com');
  const viewer = await register(app, 'viewer@example.com');
  const demoted = await app.handle({ method: 'PATCH', url: `/users/${viewer.id}/role`, headers: admin.headers, body: { role: 'viewer' } });
  assert.equal(demoted.status, 200);
  viewer.headers = await login(app, 'viewer@example.com');
  const created = await app.handle({ method: 'POST', url: '/tasks', headers: owner.headers, body: { title: 'Assign me' } });
  assert.equal(created.status, 201);
  const events: TaskEvent[] = [];
  app.events.subscribe((event) => events.push(event));
  return { app, admin, owner, teammate, viewer, taskId: (created.body as TaskBody).id, events };
}

function assign(w: World, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: unknown }> {
  return w.app.handle({ method: 'PATCH', url: `/tasks/${w.taskId}/assignee`, headers, body });
}

describe('task assignment', () => {
  it('starts unassigned', async () => {
    const w = await world();
    const response = await w.app.handle({ method: 'GET', url: `/tasks/${w.taskId}`, headers: w.owner.headers });
    assert.equal((response.body as TaskBody).assigneeId, null);
  });

  it('lets the owner assign an existing member and returns the updated task', async () => {
    const w = await world();
    const response = await assign(w, w.owner.headers, { assigneeId: w.teammate.id });
    assert.equal(response.status, 200);
    const task = response.body as TaskBody;
    assert.equal(task.id, w.taskId);
    assert.equal(task.assigneeId, w.teammate.id);
  });

  it('publishes a task.updated event with the new assignee', async () => {
    const w = await world();
    await assign(w, w.owner.headers, { assigneeId: w.teammate.id });
    const updated = w.events.filter((event) => event.type === 'task.updated');
    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.task.assigneeId, w.teammate.id);
  });

  it('filters the task list by assignee', async () => {
    const w = await world();
    await assign(w, w.owner.headers, { assigneeId: w.teammate.id });
    const mine = await w.app.handle({ method: 'GET', url: `/tasks?assignee=${w.teammate.id}`, headers: w.owner.headers });
    assert.deepEqual((mine.body as { items: TaskBody[] }).items.map((task) => task.id), [w.taskId]);
    const others = await w.app.handle({ method: 'GET', url: `/tasks?assignee=${w.owner.id}`, headers: w.owner.headers });
    assert.equal((others.body as { items: TaskBody[] }).items.length, 0);
  });

  it('answers 404 for an unknown user and 400 for a viewer', async () => {
    const w = await world();
    assert.equal((await assign(w, w.owner.headers, { assigneeId: 'user_does_not_exist' })).status, 404);
    const viewerResponse = await assign(w, w.owner.headers, { assigneeId: w.viewer.id });
    assert.equal(viewerResponse.status, 400);
    assert.match(JSON.stringify(viewerResponse.body), /assigneeId/);
  });

  it('answers 400 for malformed bodies', async () => {
    const w = await world();
    for (const body of [{}, { assigneeId: 42 }, { assigneeId: '' }, undefined]) {
      assert.equal((await assign(w, w.owner.headers, body)).status, 400);
    }
  });

  it('applies the owner-or-admin rule and requires authentication', async () => {
    const w = await world();
    assert.equal((await assign(w, w.teammate.headers, { assigneeId: w.teammate.id })).status, 403);
    assert.equal((await assign(w, w.viewer.headers, { assigneeId: w.teammate.id })).status, 403);
    assert.equal((await assign(w, w.admin.headers, { assigneeId: w.teammate.id })).status, 200);
    assert.equal((await assign(w, {}, { assigneeId: w.teammate.id })).status, 401);
  });

  it('clears the assignment with null', async () => {
    const w = await world();
    await assign(w, w.owner.headers, { assigneeId: w.teammate.id });
    const cleared = await assign(w, w.owner.headers, { assigneeId: null });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as TaskBody).assigneeId, null);
    const listed = await w.app.handle({ method: 'GET', url: `/tasks?assignee=${w.teammate.id}`, headers: w.owner.headers });
    assert.equal((listed.body as { items: TaskBody[] }).items.length, 0);
  });
});
