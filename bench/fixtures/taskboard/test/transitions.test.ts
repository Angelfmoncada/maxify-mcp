import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TASK_STATUSES } from '../src/shared/constants.ts';
import { ConflictError } from '../src/shared/errors.ts';
import type { TaskStatus } from '../src/shared/types.ts';
import { assertTransition, canTransition, nextStatuses } from '../src/server/tasks/transitions.ts';

const ALLOWED: Array<[TaskStatus, TaskStatus]> = [
  ['todo', 'in_progress'],
  ['in_progress', 'todo'],
  ['in_progress', 'in_review'],
  ['in_progress', 'done'],
  ['in_review', 'in_progress'],
  ['in_review', 'done'],
  ['done', 'in_progress'],
];

describe('canTransition', () => {
  for (const [from, to] of ALLOWED) {
    it(`allows ${from} -> ${to}`, () => {
      assert.equal(canTransition(from, to), true);
    });
  }

  it('forbids skipping the review column from todo', () => {
    assert.equal(canTransition('todo', 'in_review'), false);
    assert.equal(canTransition('todo', 'done'), false);
  });

  it('only lets a finished task be reopened into in_progress', () => {
    assert.equal(canTransition('done', 'todo'), false);
    assert.equal(canTransition('done', 'in_review'), false);
  });

  it('treats staying in the same status as an invalid move', () => {
    for (const status of TASK_STATUSES) assert.equal(canTransition(status, status), false);
  });
});

describe('nextStatuses', () => {
  it('lists the reachable statuses', () => {
    assert.deepEqual(nextStatuses('in_review'), ['in_progress', 'done']);
  });
});

describe('assertTransition', () => {
  it('throws a conflict error that names both statuses', () => {
    assert.throws(
      () => assertTransition('todo', 'done'),
      (error: unknown) => error instanceof ConflictError && /todo to done/.test(error.message),
    );
  });

  it('does nothing for an allowed move', () => {
    assert.doesNotThrow(() => assertTransition('in_progress', 'done'));
  });
});
