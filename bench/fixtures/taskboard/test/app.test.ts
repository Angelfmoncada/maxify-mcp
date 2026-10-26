import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authed, createTestApp, signUp } from './helpers/factories.ts';

interface TaskBody {
  id: string;
  title: string;
  status: string;
  ownerId: string;
}

describe('authentication endpoints', () => {
  it('answers 401 without credentials and 200 with a fresh token', async () => {
    const { app } = createTestApp();
    assert.equal((await app.handle({ method: 'GET', url: '/tasks' })).status, 401);
    const admin = await signUp(app, 'admin@example.com');
    assert.equal((await app.handle(authed(admin, 'GET', '/tasks'))).status, 200);
  });

  it('logs in with the registered credentials', async () => {
    const { app } = createTestApp();
    await signUp(app, 'ada@example.com');
    const response = await app.handle({
      method: 'POST',
      url: '/auth/login',
      body: { email: 'ada@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(response.status, 200);
    assert.equal((response.body as { user: { email: string } }).user.email, 'ada@example.com');
  });

  it('rejects a token once the clock passes its expiry', async () => {
    const { app, clock } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    clock.advance(2 * 3_600_000);
    assert.equal((await app.handle(authed(admin, 'GET', '/auth/me'))).status, 401);
  });

  it('lists users for admins only', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    const member = await signUp(app, 'member@example.com');
    assert.equal((await app.handle(authed(admin, 'GET', '/users'))).status, 200);
    assert.equal((await app.handle(authed(member, 'GET', '/users'))).status, 403);
  });
});

describe('task endpoints', () => {
  it('creates, reads, updates and deletes a task', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    const member = await signUp(app, 'member@example.com');

    const created = await app.handle(authed(member, 'POST', '/tasks', { title: 'Plan sprint', priority: 'high' }));
    assert.equal(created.status, 201);
    const task = created.body as TaskBody;
    assert.equal(task.ownerId, member.userId);

    const patched = await app.handle(authed(member, 'PATCH', `/tasks/${task.id}`, { title: 'Plan the sprint' }));
    assert.equal((patched.body as TaskBody).title, 'Plan the sprint');

    const moved = await app.handle(authed(member, 'POST', `/tasks/${task.id}/status`, { status: 'in_progress' }));
    assert.equal((moved.body as TaskBody).status, 'in_progress');

    assert.equal((await app.handle(authed(admin, 'DELETE', `/tasks/${task.id}`))).status, 204);
    assert.equal((await app.handle(authed(member, 'GET', `/tasks/${task.id}`))).status, 404);
  });

  it('answers 400 with the validation issues for a bad body', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    const response = await app.handle(authed(admin, 'POST', '/tasks', { title: '' }));
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /VALIDATION_FAILED/);
  });

  it('answers 409 for a status move the board does not allow', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    const created = await app.handle(authed(admin, 'POST', '/tasks', { title: 'Skip ahead' }));
    const id = (created.body as TaskBody).id;
    const response = await app.handle(authed(admin, 'POST', `/tasks/${id}/status`, { status: 'done' }));
    assert.equal(response.status, 409);
  });

  it('keeps viewers read-only', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    const viewer = await signUp(app, 'viewer@example.com');
    const demoted = await app.handle(authed(admin, 'PATCH', `/users/${viewer.userId}/role`, { role: 'viewer' }));
    assert.equal(demoted.status, 200);
    // The role is part of the token, so sign in again to pick up the new role.
    const login = await app.handle({
      method: 'POST',
      url: '/auth/login',
      body: { email: 'viewer@example.com', password: 'correct-horse-battery' },
    });
    const viewerSession = { token: (login.body as { token: string }).token, userId: viewer.userId };

    assert.equal((await app.handle(authed(admin, 'POST', '/tasks', { title: 'Visible to all' }))).status, 201);
    assert.equal((await app.handle(authed(viewerSession, 'GET', '/tasks'))).status, 200);
    const denied = await app.handle(authed(viewerSession, 'POST', '/tasks', { title: 'Sneaky' }));
    assert.equal(denied.status, 403);
  });

  it('lists the first 20 tasks by default', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    for (let index = 0; index < 25; index += 1) {
      app.repositories.tasks.create(admin.userId, { title: `Task ${index}` }, new Date());
    }
    const response = await app.handle(authed(admin, 'GET', '/tasks'));
    const page = response.body as { items: TaskBody[]; total: number; pageSize: number };
    assert.equal(page.items.length, 20);
    assert.equal(page.pageSize, 20);
    assert.equal(page.total, 25);
  });

  it('exports tasks as CSV and quotes titles containing commas', async () => {
    const { app } = createTestApp();
    const admin = await signUp(app, 'admin@example.com');
    await app.handle(authed(admin, 'POST', '/tasks', { title: 'Plan, then build' }));
    const response = await app.handle(authed(admin, 'GET', '/tasks/export.csv'));
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/csv; charset=utf-8');
    const lines = String(response.body).trim().split('\r\n');
    assert.equal(lines[0], 'id,title,status,priority,ownerId,dueDate,createdAt');
    assert.match(lines[1] ?? '', /"Plan, then build",todo,medium,/);
  });
});
