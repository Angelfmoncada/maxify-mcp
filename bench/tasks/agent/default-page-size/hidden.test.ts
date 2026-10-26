import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/server/app.ts';
import { silentLogger } from '../src/server/util/logger.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/shared/constants.ts';
import { paginate } from '../src/shared/utils.ts';

describe('default page size is 25', () => {
  it('has the new default and keeps the maximum', () => {
    assert.equal(DEFAULT_PAGE_SIZE, 25);
    assert.equal(MAX_PAGE_SIZE, 100);
  });

  it('paginate uses the default size', () => {
    const page = paginate(Array.from({ length: 60 }, (_, index) => index));
    assert.equal(page.items.length, 25);
    assert.equal(page.pageSize, 25);
  });

  it('GET /tasks returns 25 tasks per page by default', async () => {
    const app = createApp({ env: { NODE_ENV: 'test' }, config: { tokenSecret: 'hidden-secret-0123456789' }, logger: silentLogger });
    const registered = await app.handle({
      method: 'POST',
      url: '/auth/register',
      body: { email: 'pages@example.com', name: 'Pages', password: 'correct-horse-battery' },
    });
    const body = registered.body as { token: string; user: { id: string } };
    const headers = { authorization: `Bearer ${body.token}` };
    for (let index = 0; index < 30; index += 1) {
      app.repositories.tasks.create(body.user.id, { title: `Task ${index}` }, new Date());
    }
    const first = await app.handle({ method: 'GET', url: '/tasks', headers });
    const page = first.body as { items: unknown[]; pageSize: number; total: number };
    assert.equal(page.items.length, 25);
    assert.equal(page.pageSize, 25);
    assert.equal(page.total, 30);
    const second = await app.handle({ method: 'GET', url: '/tasks?page=2', headers });
    assert.equal((second.body as { items: unknown[] }).items.length, 5);
    const custom = await app.handle({ method: 'GET', url: '/tasks?pageSize=10', headers });
    assert.equal((custom.body as { items: unknown[] }).items.length, 10);
  });
});
