/** Roles ordered from most to least privileged. */
export type Role = 'admin' | 'member' | 'viewer';

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

/** Identity attached to a request after its bearer token has been verified. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  ownerId: string;
  /** ISO date (YYYY-MM-DD), or null when the task has no deadline. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may send when creating a task. */
export interface TaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string | null;
}

/** Fields a client may change on an existing task; the status has its own endpoint. */
export type TaskPatch = Partial<TaskInput>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginCredentials {
  name: string;
}

export interface AuthSession {
  token: string;
  user: User;
  /** ISO timestamp from which `token` is no longer accepted. */
  expiresAt: string;
}
