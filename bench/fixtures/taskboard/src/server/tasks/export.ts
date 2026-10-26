import { createRequire } from 'node:module';
import type { Task } from '../../shared/types.ts';

// The CSV helpers are CommonJS (shared with the nightly reporting script), so load them through require().
const require = createRequire(import.meta.url);
const { toCsv } = require('../lib/legacy-csv.cjs') as {
  toCsv: (rows: string[][]) => string;
};

export const TASK_CSV_COLUMNS = [
  'id',
  'title',
  'status',
  'priority',
  'ownerId',
  'dueDate',
  'createdAt',
] as const;

/** Serializes tasks as CSV with a header row; column order is TASK_CSV_COLUMNS. */
export function tasksToCsv(tasks: readonly Task[]): string {
  const rows = tasks.map((task) => TASK_CSV_COLUMNS.map((column) => String(task[column] ?? '')));
  return toCsv([[...TASK_CSV_COLUMNS], ...rows]);
}
