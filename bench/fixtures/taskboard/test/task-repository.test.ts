import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskRepository } from '../src/server/tasks/repository.ts';
import { NotFoundError } from '../src/shared/errors.ts';

const T0 = new Date('2025-01-15T12:00:00.000Z');
const T1 = new Date('2025-01-15T13:30:00.000Z');

describe('TaskRepository', () => {
  it('creates a todo task with defaults filled in', () => {
    const repository = new TaskRepository();
    const task = repository.create('user_1', { title: 'Write tests' }, T0);
    assert.match(task.id, /^task_[0-9a-f]{16}$/);
    assert.equal(task.status, 'todo');
    assert.equal(task.priority, 'medium');
    assert.equal(task.description, '');
    assert.equal(task.dueDate, null);
    assert.equal(task.ownerId, 'user_1');
    assert.equal(task.createdAt, T0.toISOString());
    assert.equal(task.updatedAt, T0.toISOString());
  });

  it('lists tasks in creation order', () => {
    const repository = new TaskRepository();
    const first = repository.create('user_1', { title: 'first' }, T0);
    const second = repository.create('user_1', { title: 'second' }, T0);
    repository.update(first.id, { title: 'first (edited)' }, T1);
    assert.deepEqual(repository.list().map((task) => task.title), ['first (edited)', 'second']);
    assert.equal(repository.count(), 2);
    assert.equal(repository.findById(second.id)?.title, 'second');
  });

  it('replaces the stored task on update instead of mutating it', () => {
    const repository = new TaskRepository();
    const original = repository.create('user_1', { title: 'draft' }, T0);
    const updated = repository.update(original.id, { status: 'in_progress' }, T1);
    assert.equal(original.status, 'todo');
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.updatedAt, T1.toISOString());
    assert.equal(updated.createdAt, T0.toISOString());
  });

  it('throws NotFoundError when updating an unknown id', () => {
    assert.throws(() => new TaskRepository().update('task_missing', { title: 'x' }, T1), NotFoundError);
  });

  it('reports whether a delete removed anything', () => {
    const repository = new TaskRepository();
    const task = repository.create('user_1', { title: 'temp' }, T0);
    assert.equal(repository.delete(task.id), true);
    assert.equal(repository.delete(task.id), false);
    assert.equal(repository.findById(task.id), undefined);
  });
});
