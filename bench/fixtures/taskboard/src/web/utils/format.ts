import type { TaskPriority, TaskStatus } from '@shared/types';

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status];
}

export function priorityLabel(priority: TaskPriority): string {
  return PRIORITY_LABELS[priority];
}

/** "Mar 5" style label for an ISO date. Empty string when the task has no due date. */
export function formatDueDate(iso: string | null, locale: string = 'en-US'): string {
  if (iso === null) return '';
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** True when the ISO due date lies before today (UTC). */
export function isPastDue(iso: string | null, today: Date = new Date()): boolean {
  return iso !== null && iso < today.toISOString().slice(0, 10);
}
