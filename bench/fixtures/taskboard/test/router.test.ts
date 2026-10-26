import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ok } from '../src/server/http/responses.ts';
import { Router, compose, matchPattern } from '../src/server/http/router.ts';
import type { Middleware } from '../src/server/http/types.ts';
import { ConflictError } from '../src/shared/errors.ts';

describe('matchPattern', () => {
  it('captures named segments and decodes them', () => {
    assert.deepEqual(matchPattern(['tasks', ':id'], '/tasks/a%20b'), { id: 'a b' });
  });

  it('requires the same number of segments', () => {
    assert.equal(matchPattern(['tasks', ':id'], '/tasks'), null);
    assert.equal(matchPattern(['tasks'], '/tasks/1'), null);
  });

  it('requires literal segments to be equal', () => {
    assert.equal(matchPattern(['tasks', 'export.csv'], '/tasks/other'), null);
  });
});

describe('compose', () => {
  it('runs middleware outside-in and lets a layer replace the request', async () => {
    const order: string[] = [];
    const tag =
      (label: string): Middleware =>
      async (request, next) => {
        order.push(`${label}:before`);
        const response = await next({ ...request, query: { ...request.query, [label]: '1' } });
        order.push(`${label}:after`);
        return response;
      };
    const run = compose([tag('a'), tag('b')], (request) => ok(Object.keys(request.query)));
    const response = await run({ method: 'GET', path: '/', query: {}, params: {}, headers: {}, body: undefined });
    assert.deepEqual(order, ['a:before', 'b:before', 'b:after', 'a:after']);
    assert.deepEqual(response.body, ['a', 'b']);
  });

  it('stops the chain when a layer answers without calling next', async () => {
    const stop: Middleware = async () => ({ status: 418, headers: {}, body: 'stopped' });
    const run = compose([stop], () => ok('never'));
    const response = await run({ method: 'GET', path: '/', query: {}, params: {}, headers: {}, body: undefined });
    assert.equal(response.status, 418);
  });
});

describe('Router.handle', () => {
  const router = new Router()
    .get('/ping', () => ok('pong'))
    .get('/items/:id', (request) => ok({ id: request.params.id, query: request.query }))
    .post('/items', (request) => ok(request.body))
    .get('/boom', () => {
      throw new ConflictError('already there');
    })
    .get('/crash', () => {
      throw new Error('secret internals');
    });

  it('routes by method and path and parses the query string', async () => {
    const response = await router.handle({ method: 'get', url: '/items/42?color=red' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: '42', query: { color: 'red' } });
  });

  it('passes the body through', async () => {
    const response = await router.handle({ method: 'POST', url: '/items', body: { name: 'x' } });
    assert.deepEqual(response.body, { name: 'x' });
  });

  it('answers 404 for unknown paths and 405 for the wrong method', async () => {
    assert.equal((await router.handle({ method: 'GET', url: '/nope' })).status, 404);
    assert.equal((await router.handle({ method: 'DELETE', url: '/ping' })).status, 405);
    assert.equal((await router.handle({ method: 'TRACE', url: '/ping' })).status, 405);
  });

  it('maps application errors to their status and hides unexpected ones', async () => {
    const conflict = await router.handle({ method: 'GET', url: '/boom' });
    assert.equal(conflict.status, 409);
    const crash = await router.handle({ method: 'GET', url: '/crash' });
    assert.equal(crash.status, 500);
    assert.doesNotMatch(JSON.stringify(crash.body), /secret internals/);
  });

  it('lower-cases header names', async () => {
    const echo = new Router().get('/h', (request) => ok(request.headers));
    const response = await echo.handle({ method: 'GET', url: '/h', headers: { 'X-Trace-Id': 'abc' } });
    assert.deepEqual(response.body, { 'x-trace-id': 'abc' });
  });
});
