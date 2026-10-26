import { DEFAULT_PAGE_SIZE } from '@shared/constants';
import type { Task, TaskStatus } from '@shared/types';
import { TaskItem } from './TaskItem';

export interface TaskListProps {
  tasks: Task[];
  total: number;
  page: number;
  loading: boolean;
  onChangeStatus: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onPageChange: (page: number) => void;
}

export function TaskList({ tasks, total, page, loading, onChangeStatus, onDelete, onPageChange }: TaskListProps) {
  const pageCount = Math.max(Math.ceil(total / DEFAULT_PAGE_SIZE), 1);

  if (loading && tasks.length === 0) return <p className="task-list__empty">Loading tasks...</p>;
  if (tasks.length === 0) return <p className="task-list__empty">No tasks match the current filters.</p>;

  return (
    <section className="task-list">
      <ul>
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} onChangeStatus={onChangeStatus} onDelete={onDelete} />
        ))}
      </ul>
      <nav className="task-list__pager" aria-label="Pagination">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pageCount}
        </span>
        <button type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
          Next
        </button>
      </nav>
    </section>
  );
}
