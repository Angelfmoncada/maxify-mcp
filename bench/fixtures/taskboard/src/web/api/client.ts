import type {
  AuthSession,
  LoginCredentials,
  Page,
  RegisterInput,
  Task,
  TaskInput,
  TaskPatch,
  TaskStatus,
  User,
} from '@shared/types';

/** Error returned by the API; `code` is the machine-readable ErrorCode of the server. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface TaskQuery {
  status?: TaskStatus[];
  search?: string;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ApiClient {
  login(credentials: LoginCredentials): Promise<AuthSession>;
  register(input: RegisterInput): Promise<AuthSession>;
  me(): Promise<User>;
  listTasks(query?: TaskQuery): Promise<Page<Task>>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  changeStatus(id: string, status: TaskStatus): Promise<Task>;
  deleteTask(id: string): Promise<void>;
}

export interface ApiClientOptions {
  /** The dev server proxies /api/* to the Node server and strips the prefix. */
  baseUrl?: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

/** Builds `?status=todo,done&q=...` from a task query; empty when nothing is set. */
export function toQueryString(query: TaskQuery): string {
  const params = new URLSearchParams();
  if (query.status !== undefined && query.status.length > 0) params.set('status', query.status.join(','));
  if (query.search !== undefined && query.search !== '') params.set('q', query.search);
  if (query.overdue !== undefined) params.set('overdue', String(query.overdue));
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? '/api';
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = options.getToken();
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    const payload = (await response.json()) as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) {
      throw new ApiError(response.status, payload.error?.code ?? 'UNKNOWN', payload.error?.message ?? response.statusText);
    }
    return payload;
  }

  return {
    login: (credentials) => request('POST', '/auth/login', credentials),
    register: (input) => request('POST', '/auth/register', input),
    me: () => request('GET', '/auth/me'),
    listTasks: (query = {}) => request('GET', `/tasks${toQueryString(query)}`),
    createTask: (input) => request('POST', '/tasks', input),
    updateTask: (id, patch) => request('PATCH', `/tasks/${id}`, patch),
    changeStatus: (id, status) => request('POST', `/tasks/${id}/status`, { status }),
    deleteTask: (id) => request('DELETE', `/tasks/${id}`),
  };
}
