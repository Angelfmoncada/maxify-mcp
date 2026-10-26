import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_PASSWORD_LENGTH,
  ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './constants.ts';
import { AppError } from './errors.ts';
import type {
  LoginCredentials,
  RegisterInput,
  Role,
  TaskInput,
  TaskPatch,
  TaskPriority,
  TaskStatus,
} from './types.ts';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Thrown when client input breaks the shared rules; maps to HTTP 400. */
export class ValidationError extends AppError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const summary = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
    super('VALIDATION_FAILED', 400, `Validation failed (${summary})`, { issues });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTitle(value: unknown, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ field: 'title', message: 'is required' });
    return undefined;
  }
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) {
    issues.push({ field: 'title', message: `must be at most ${MAX_TITLE_LENGTH} characters` });
    return undefined;
  }
  return title;
}

function readDescription(value: unknown, issues: ValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    issues.push({ field: 'description', message: 'must be a string' });
    return undefined;
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    issues.push({ field: 'description', message: `must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
    return undefined;
  }
  return value;
}

function readPriority(value: unknown, issues: ValidationIssue[]): TaskPriority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !TASK_PRIORITIES.includes(value as TaskPriority)) {
    issues.push({ field: 'priority', message: `must be one of ${TASK_PRIORITIES.join(', ')}` });
    return undefined;
  }
  return value as TaskPriority;
}

function readDueDate(value: unknown, issues: ValidationIssue[]): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push({ field: 'dueDate', message: 'must be an ISO date (YYYY-MM-DD) or null' });
    return undefined;
  }
  return value;
}

/** Validates the body of POST /tasks. Throws a ValidationError that lists every problem found. */
export function validateTaskInput(raw: unknown): TaskInput {
  if (!isRecord(raw)) throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  const issues: ValidationIssue[] = [];
  const title = readTitle(raw.title, issues);
  const description = readDescription(raw.description, issues);
  const priority = readPriority(raw.priority, issues);
  const dueDate = readDueDate(raw.dueDate, issues);
  if (issues.length > 0 || title === undefined) throw new ValidationError(issues);
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
  };
}

/** Validates the body of PATCH /tasks/:id: every field is optional, but at least one must be present. */
export function validateTaskPatch(raw: unknown): TaskPatch {
  if (!isRecord(raw)) throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  const issues: ValidationIssue[] = [];
  const title = 'title' in raw ? readTitle(raw.title, issues) : undefined;
  const description = readDescription(raw.description, issues);
  const priority = readPriority(raw.priority, issues);
  const dueDate = readDueDate(raw.dueDate, issues);
  const patch: TaskPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
  };
  if (issues.length === 0 && Object.keys(patch).length === 0) {
    issues.push({ field: 'body', message: 'must contain at least one field to change' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return patch;
}

/** Validates the body of POST /tasks/:id/status. */
export function validateStatus(raw: unknown): TaskStatus {
  const value = isRecord(raw) ? raw.status : raw;
  if (typeof value !== 'string' || !TASK_STATUSES.includes(value as TaskStatus)) {
    throw new ValidationError([{ field: 'status', message: `must be one of ${TASK_STATUSES.join(', ')}` }]);
  }
  return value as TaskStatus;
}

/** Validates the body of PATCH /users/:id/role. */
export function validateRole(raw: unknown): Role {
  const value = isRecord(raw) ? raw.role : raw;
  if (typeof value !== 'string' || !ROLES.includes(value as Role)) {
    throw new ValidationError([{ field: 'role', message: `must be one of ${ROLES.join(', ')}` }]);
  }
  return value as Role;
}

function readEmail(value: unknown, issues: ValidationIssue[]): string {
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    issues.push({ field: 'email', message: 'must be a valid email address' });
    return '';
  }
  return value.trim().toLowerCase();
}

function readPassword(value: unknown, issues: ValidationIssue[]): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    issues.push({ field: 'password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return '';
  }
  return value;
}

export function validateLoginInput(raw: unknown): LoginCredentials {
  if (!isRecord(raw)) throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  const issues: ValidationIssue[] = [];
  const email = readEmail(raw.email, issues);
  const password = readPassword(raw.password, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { email, password };
}

export function validateRegisterInput(raw: unknown): RegisterInput {
  if (!isRecord(raw)) throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  const issues: ValidationIssue[] = [];
  const email = readEmail(raw.email, issues);
  const password = readPassword(raw.password, issues);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length === 0) issues.push({ field: 'name', message: 'is required' });
  if (issues.length > 0) throw new ValidationError(issues);
  return { email, password, name };
}
