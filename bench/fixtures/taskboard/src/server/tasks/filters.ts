import { TASK_STATUSES } from '../../shared/constants.ts';
import { paginate } from '../../shared/utils.ts';
import { ValidationError } from '../../shared/validation.ts';
import type { ValidationIssue } from '../../shared/validation.ts';
import type { Page, Task, TaskPriority, TaskStatus } from '../../shared/types.ts';

export type TaskSortKey = 'createdAt' | 'dueDate' | 'priority' | 'title';

export interface TaskFilter {
  status?: TaskStatus[];
  ownerId?: string;
  /** Case-insensitive substring searched in title and description. */
  search?: string;
  overdue?: boolean;
  sort?: TaskSortKey;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

const SORT_KEYS: readonly TaskSortKey[] = ['createdAt', 'dueDate', 'priority', 'title'];

const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

/** True when the task has a due date before today (UTC) and is not done yet. */
export function isOverdue(task: Task, now: Date): boolean {
  if (task.status === 'done' || task.dueDate === null) return false;
  return task.dueDate < now.toISOString().slice(0, 10);
}

function parsePositiveInt(name: string, raw: string, issues: ValidationIssue[]): number | undefined {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    issues.push({ field: name, message: 'must be a positive integer' });
    return undefined;
  }
  return value;
}

/** Turns query-string parameters (`status`, `owner`, `q`, `overdue`, `sort`, `dir`, `page`, `pageSize`) into a filter. */
export function parseTaskFilter(query: Record<string, string>): TaskFilter {
  const issues: ValidationIssue[] = [];
  const filter: TaskFilter = {};

  if (query.status !== undefined) {
    const statuses = query.status.split(',').filter((item) => item.length > 0);
    const unknown = statuses.filter((item) => !TASK_STATUSES.includes(item as TaskStatus));
    if (unknown.length > 0) {
      issues.push({ field: 'status', message: `unknown status: ${unknown.join(', ')}` });
    }
    filter.status = statuses as TaskStatus[];
  }
  if (query.owner !== undefined) filter.ownerId = query.owner;
  if (query.q !== undefined && query.q.trim().length > 0) filter.search = query.q.trim();
  if (query.overdue !== undefined) filter.overdue = query.overdue === 'true';
  if (query.sort !== undefined) {
    if (SORT_KEYS.includes(query.sort as TaskSortKey)) {
      filter.sort = query.sort as TaskSortKey;
    } else {
      issues.push({ field: 'sort', message: `must be one of ${SORT_KEYS.join(', ')}` });
    }
  }
  if (query.dir !== undefined) filter.direction = query.dir === 'desc' ? 'desc' : 'asc';
  if (query.page !== undefined) filter.page = parsePositiveInt('page', query.page, issues);
  if (query.pageSize !== undefined) filter.pageSize = parsePositiveInt('pageSize', query.pageSize, issues);

  if (issues.length > 0) throw new ValidationError(issues);
  return filter;
}

export function filterTasks(tasks: readonly Task[], filter: TaskFilter, now: Date): Task[] {
  const search = filter.search?.toLowerCase();
  return tasks.filter((task) => {
    if (filter.status !== undefined && filter.status.length > 0 && !filter.status.includes(task.status)) {
      return false;
    }
    if (filter.ownerId !== undefined && task.ownerId !== filter.ownerId) return false;
    if (filter.overdue !== undefined && isOverdue(task, now) !== filter.overdue) return false;
    if (search !== undefined) {
      const haystack = `${task.title}\n${task.description}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function compareTasks(a: Task, b: Task, key: TaskSortKey): number {
  switch (key) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'title':
      return a.title.localeCompare(b.title);
    case 'dueDate':
      // Tasks without a deadline sort after tasks that have one.
      return (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31');
    case 'createdAt':
      return a.createdAt.localeCompare(b.createdAt);
  }
}

export function sortTasks(tasks: readonly Task[], key: TaskSortKey, direction: 'asc' | 'desc'): Task[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => sign * compareTasks(a, b, key));
}

/** Applies filter, sort and pagination in that order. */
export function queryTasks(tasks: readonly Task[], filter: TaskFilter, now: Date): Page<Task> {
  const matching = filterTasks(tasks, filter, now);
  const ordered = filter.sort === undefined ? matching : sortTasks(matching, filter.sort, filter.direction ?? 'asc');
  return paginate(ordered, filter.page, filter.pageSize);
}
