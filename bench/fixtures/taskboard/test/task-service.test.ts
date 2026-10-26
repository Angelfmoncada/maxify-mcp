import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { TaskEventBus } from '../src/server/tasks/events.ts';
import type { TaskEvent } from '../src/server/tasks/events.ts';
import { TaskRepository } from '../src/server/tasks/repository.ts';
import { TaskService, canModify } from '../src/server/tasks/service.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../src/shared/errors.ts';
import { ValidationError } from '../src/shared/validation.ts';
import { TestClock, makeTask, makeUser } from './helpers/factories.ts';

const owner = makeUser({ id: 'user_owner', role: 'member' });
const stranger = makeUser({ id: 'user_stranger', role: 'member' });
const admin = makeUser({ id: 'user_admin', role: 'admin' });
const viewer = makeUser({ id: 'user_viewer', role: 'viewer' });

let service: TaskService;
let events: TaskEvent[];

beforeEach(() => {
  const bus = new TaskEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  service = new TaskService(new TaskRepository(), bus, new TestClock().now);
});

describe('canModify', () => {
  const task = makeTask({ ownerId: 'user_owner' });

  it('lets the owner and any admin modify a task', () => {
    assert.equal(canModify(owner, task), true);
    assert.equal(canModify(admin, task), true);
  });

  it('keeps other members and viewers out', () => {
    assert.equal(canModify(stranger, task), false);
    assert.equal(canModify(viewer, task), false);
  });

  it('does not let a viewer modify a task they own', () => {
    assert.equal(canModify(viewer, makeTask({ ownerId: 'user_viewer' })), false);
  });
});

describe('TaskService.create', () => {
  it('stores the task for the actor and publishes task.created', () => {
    const task = service.create(owner, { title: 'Draft the roadmap', priority: 'high' });
    assert.equal(task.ownerId, 'user_owner');
    assert.equal(task.priority, 'high');
    assert.deepEqual(events.map((event) => event.type), ['task.created']);
  });

  it('forbids viewers', () => {
    assert.throws(() => service.create(viewer, { title: 'Nope' }), ForbiddenError);
    assert.equal(events.length, 0);
  });

  it('validates the body', () => {
    assert.throws(() => service.create(owner, { title: '' }), ValidationError);
  });
});

describe('TaskService.get', () => {
  it('throws NotFoundError for an unknown id', () => {
    assert.throws(() => service.get('task_missing'), NotFoundError);
  });
});

describe('TaskService.update', () => {
  it('lets the owner change fields and publishes task.updated with the previous version', () => {
    const task = service.create(owner, { title: 'Old title' });
    const updated = service.update(owner, task.id, { title: 'New title' });
    assert.equal(updated.title, 'New title');
    const event = events.at(-1);
    assert.equal(event?.type, 'task.updated');
    assert.equal(event?.type === 'task.updated' ? event.before.title : '', 'Old title');
  });

  it('lets an admin edit tasks of other users', () => {
    const task = service.create(owner, { title: 'Owned by someone else' });
    assert.equal(service.update(admin, task.id, { priority: 'low' }).priority, 'low');
  });

  it('forbids other members, naming the rule in the message', () => {
    const task = service.create(owner, { title: 'Mine' });
    assert.throws(() => service.update(stranger, task.id, { title: 'Hijacked' }), /Only the owner or an admin can update/);
  });
});

describe('TaskService.updateStatus', () => {
  it('walks a task through the board and records the previous status', () => {
    const task = service.create(owner, { title: 'Ship v2' });
    service.updateStatus(owner, task.id, 'in_progress');
    const done = service.updateStatus(owner, task.id, { status: 'done' });
    assert.equal(done.status, 'done');
    const event = events.at(-1);
    assert.equal(event?.type === 'task.status_changed' ? event.from : '', 'in_progress');
  });

  it('rejects moves that the board does not allow', () => {
    const task = service.create(owner, { title: 'Ship v2' });
    assert.throws(() => service.updateStatus(owner, task.id, 'done'), ConflictError);
  });

  it('applies the transition rules to admins as well', () => {
    const task = service.create(owner, { title: 'Ship v2' });
    assert.throws(() => service.updateStatus(admin, task.id, 'in_review'), ConflictError);
  });

  it('forbids viewers and strangers', () => {
    const task = service.create(owner, { title: 'Ship v2' });
    assert.throws(() => service.updateStatus(viewer, task.id, 'in_progress'), ForbiddenError);
    assert.throws(() => service.updateStatus(stranger, task.id, 'in_progress'), ForbiddenError);
  });
});

describe('TaskService.delete', () => {
  it('removes the task and publishes task.deleted', () => {
    const task = service.create(owner, { title: 'Throwaway' });
    service.delete(owner, task.id);
    assert.throws(() => service.get(task.id), NotFoundError);
    assert.equal(events.at(-1)?.type, 'task.deleted');
  });

  it('says that deleting needs the owner or an admin', () => {
    const task = service.create(owner, { title: 'Keep me' });
    assert.throws(() => service.delete(stranger, task.id), /Only the owner or an admin can delete this task/);
    assert.doesNotThrow(() => service.delete(admin, task.id));
  });
});

describe('TaskService.list', () => {
  it('filters by status through the query string', () => {
    const first = service.create(owner, { title: 'one' });
    service.create(owner, { title: 'two' });
    service.updateStatus(owner, first.id, 'in_progress');
    const page = service.list({ status: 'in_progress' });
    assert.deepEqual(page.items.map((task) => task.title), ['one']);
    assert.equal(page.total, 1);
  });
});
