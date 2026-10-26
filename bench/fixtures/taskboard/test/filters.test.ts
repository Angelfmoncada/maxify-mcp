import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/shared/constants.ts';
import { paginate } from '../src/shared/utils.ts';
import { ValidationError } from '../src/shared/validation.ts';
import { filterTasks, isOverdue, parseTaskFilter, queryTasks, sortTasks } from '../src/server/tasks/filters.ts';
import { makeTask } from './helpers/factories.ts';

const NOW = new Date('2025-01-15T12:00:00.000Z');

const tasks = [
  makeTask({ id: 't1', title: 'Fix login bug', status: 'in_progress', priority: 'urgent', dueDate: '2025-01-10', createdAt: '2025-01-01T00:00:00.000Z' }),
  makeTask({ id: 't2', title: 'Write docs', description: 'login flow', status: 'todo', priority: 'low', dueDate: '2025-02-01', createdAt: '2025-01-02T00:00:00.000Z' }),
  makeTask({ id: 't3', title: 'Release', status: 'done', priority: 'high', dueDate: '2025-01-05', ownerId: 'user_other', createdAt: '2025-01-03T00:00:00.000Z' }),
  makeTask({ id: 't4', title: 'Backlog grooming', status: 'todo', priority: 'medium', dueDate: null, createdAt: '2025-01-04T00:00:00.000Z' }),
];

const ids = (list: readonly { id: string }[]): string[] => list.map((task) => task.id);

describe('isOverdue', () => {
  it('flags unfinished tasks whose due date has passed', () => {
    assert.equal(isOverdue(tasks[0]!, NOW), true);
  });

  it('ignores finished tasks, future dates and tasks without a deadline', () => {
    assert.equal(isOverdue(tasks[2]!, NOW), false);
    assert.equal(isOverdue(tasks[1]!, NOW), false);
    assert.equal(isOverdue(tasks[3]!, NOW), false);
  });
});

describe('parseTaskFilter', () => {
  it('reads every supported parameter', () => {
    const filter = parseTaskFilter({
      status: 'todo,done',
      owner: 'user_other',
      q: ' login ',
      overdue: 'true',
      sort: 'priority',
      dir: 'desc',
      page: '2',
      pageSize: '10',
    });
    assert.deepEqual(filter, {
      status: ['todo', 'done'],
      ownerId: 'user_other',
      search: 'login',
      overdue: true,
      sort: 'priority',
      direction: 'desc',
      page: 2,
      pageSize: 10,
    });
  });

  it('rejects unknown statuses, sort keys and bad numbers together', () => {
    assert.throws(
      () => parseTaskFilter({ status: 'blocked', sort: 'color', page: '0' }),
      (error: unknown) => error instanceof ValidationError && error.issues.length === 3,
    );
  });
});

describe('filterTasks', () => {
  it('filters by status list', () => {
    assert.deepEqual(ids(filterTasks(tasks, { status: ['todo'] }, NOW)), ['t2', 't4']);
  });

  it('searches title and description case-insensitively', () => {
    assert.deepEqual(ids(filterTasks(tasks, { search: 'LOGIN' }, NOW)), ['t1', 't2']);
  });

  it('filters by owner and by overdue flag', () => {
    assert.deepEqual(ids(filterTasks(tasks, { ownerId: 'user_other' }, NOW)), ['t3']);
    assert.deepEqual(ids(filterTasks(tasks, { overdue: true }, NOW)), ['t1']);
  });
});

describe('sortTasks', () => {
  it('orders by priority rank, not alphabetically', () => {
    assert.deepEqual(ids(sortTasks(tasks, 'priority', 'desc')), ['t1', 't3', 't4', 't2']);
  });

  it('puts tasks without a due date last when sorting ascending', () => {
    assert.deepEqual(ids(sortTasks(tasks, 'dueDate', 'asc')), ['t3', 't1', 't2', 't4']);
  });
});

describe('queryTasks and paginate', () => {
  it('returns the first page with the default size', () => {
    const many = Array.from({ length: DEFAULT_PAGE_SIZE + 5 }, (_, index) => makeTask({ id: `t${index}` }));
    const page = queryTasks(many, {}, NOW);
    assert.equal(page.items.length, DEFAULT_PAGE_SIZE);
    assert.equal(page.total, DEFAULT_PAGE_SIZE + 5);
    assert.equal(page.pageSize, DEFAULT_PAGE_SIZE);
  });

  it('clamps the page size to the allowed range', () => {
    assert.equal(paginate([1, 2, 3], 1, 0).pageSize, 1);
    assert.equal(paginate([1, 2, 3], 1, MAX_PAGE_SIZE * 5).pageSize, MAX_PAGE_SIZE);
  });

  it('returns the remainder on the last page and nothing past it', () => {
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2).items, [5]);
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 4, 2).items, []);
  });
});
