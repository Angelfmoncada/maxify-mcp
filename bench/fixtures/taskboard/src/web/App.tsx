import { useMemo } from 'react';
import { TASK_STATUSES } from '@shared/constants';
import type { TaskStatus } from '@shared/types';
import { createApiClient } from './api/client';
import { LoginForm } from './components/LoginForm';
import { TaskForm } from './components/TaskForm';
import { TaskList } from './components/TaskList';
import { AuthProvider, readStoredToken, useAuth } from './hooks/useAuth';
import { useTasks } from './hooks/useTasks';
import type { ApiClient } from './api/client';

function Board({ client }: { client: ApiClient }) {
  const { user, logout, hasRole } = useAuth();
  const board = useTasks(client);

  return (
    <main>
      <header>
        <h1>Taskboard</h1>
        <span>
          {user?.name} ({user?.role})
        </span>
        <button type="button" onClick={logout}>
          Sign out
        </button>
      </header>
      <input
        type="search"
        placeholder="Search tasks"
        value={board.search}
        onChange={(event) => board.setSearch(event.target.value)}
      />
      <select
        aria-label="Filter by status"
        onChange={(event) => {
          const value = event.target.value;
          board.setStatusFilter(value === '' ? [] : [value as TaskStatus]);
        }}
      >
        <option value="">All statuses</option>
        {TASK_STATUSES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      {board.error !== null && <p role="alert">{board.error}</p>}
      {hasRole('admin', 'member') && <TaskForm onSubmit={board.createTask} />}
      <TaskList
        tasks={board.visibleTasks}
        total={board.total}
        page={board.page}
        loading={board.loading}
        onChangeStatus={(id, status) => void board.changeStatus(id, status)}
        onDelete={(id) => void board.removeTask(id)}
        onPageChange={board.setPage}
      />
    </main>
  );
}

function Shell({ client }: { client: ApiClient }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  return isAuthenticated ? <Board client={client} /> : <LoginForm />;
}

export function App() {
  const client = useMemo(() => createApiClient({ getToken: readStoredToken }), []);
  return (
    <AuthProvider client={client}>
      <Shell client={client} />
    </AuthProvider>
  );
}
