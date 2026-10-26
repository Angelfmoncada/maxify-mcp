import type { Role, TaskPriority, TaskStatus } from './types.ts';

export const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MIN_PASSWORD_LENGTH = 8;

/** Number of tasks returned per page when the client does not ask for a size. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Lifetime of a freshly issued bearer token. */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
