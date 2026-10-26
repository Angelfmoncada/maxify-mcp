import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PAGE_SIZE } from '@shared/constants';
import type { Task, TaskInput, TaskStatus } from '@shared/types';
import type { ApiClient, TaskQuery } from '../api/client';
import { matchesAllTerms, tokenize } from '../utils/tokenize';

export interface UseTasksResult {
  tasks: Task[];
  /** Tasks after the client-side search box filter has been applied. */
  visibleTasks: Task[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
  search: string;
  setSearch(value: string): void;
  setPage(page: number): void;
  setStatusFilter(statuses: TaskStatus[]): void;
  createTask(input: TaskInput): Promise<void>;
  changeStatus(id: string, status: TaskStatus): Promise<void>;
  removeTask(id: string): Promise<void>;
  reload(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

/** Loads one page of tasks and exposes optimistic mutations. */
export function useTasks(client: ApiClient): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const query: TaskQuery = { page, pageSize: DEFAULT_PAGE_SIZE, status: statusFilter };
    try {
      const result = await client.listTasks(query);
      setTasks(result.items);
      setTotal(result.total);
      setError(null);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [client, page, statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createTask = useCallback(
    async (input: TaskInput) => {
      const task = await client.createTask(input);
      setTasks((current) => [...current, task]);
      setTotal((current) => current + 1);
    },
    [client],
  );

  const changeStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      const previous = tasks;
      setTasks((current) => current.map((task) => (task.id === id ? { ...task, status } : task)));
      try {
        const updated = await client.changeStatus(id, status);
        setTasks((current) => current.map((task) => (task.id === id ? updated : task)));
      } catch (caught: unknown) {
        setTasks(previous);
        setError(errorMessage(caught));
      }
    },
    [client, tasks],
  );

  const removeTask = useCallback(
    async (id: string) => {
      await client.deleteTask(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      setTotal((current) => Math.max(current - 1, 0));
    },
    [client],
  );

  const visibleTasks = useMemo(() => {
    const terms = tokenize(search);
    if (terms.length === 0) return tasks;
    return tasks.filter((task) => matchesAllTerms(`${task.title} ${task.description}`, terms));
  }, [tasks, search]);

  return {
    tasks,
    visibleTasks,
    total,
    page,
    loading,
    error,
    search,
    setSearch,
    setPage,
    setStatusFilter,
    createTask,
    changeStatus,
    removeTask,
    reload,
  };
}
