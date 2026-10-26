import { ConflictError } from '../../shared/errors.ts';
import type { TaskStatus } from '../../shared/types.ts';

/** Allowed status moves. A finished task can only be reopened into `in_progress`. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['in_progress'],
  in_progress: ['todo', 'in_review', 'done'],
  in_review: ['in_progress', 'done'],
  done: ['in_progress'],
};

export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws a ConflictError (HTTP 409) when `from` -> `to` is not an allowed move. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move a task from ${from} to ${to}`);
  }
}
