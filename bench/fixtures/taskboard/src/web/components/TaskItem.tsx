import { TASK_STATUSES } from '@shared/constants';
import type { Task, TaskStatus } from '@shared/types';
import { useAuth } from '../hooks/useAuth';
import { formatDueDate, isPastDue, priorityLabel } from '../utils/format';
import { StatusBadge } from './StatusBadge';

export interface TaskItemProps {
  task: Task;
  onChangeStatus: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
}

export function TaskItem({ task, onChangeStatus, onDelete }: TaskItemProps) {
  const { canModify } = useAuth();
  const editable = canModify(task);
  const overdue = task.status !== 'done' && isPastDue(task.dueDate);

  return (
    <li className={overdue ? 'task-item task-item--overdue' : 'task-item'}>
      <div className="task-item__header">
        <h3>{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>
      {task.description !== '' && <p className="task-item__description">{task.description}</p>}
      <dl className="task-item__meta">
        <dt>Priority</dt>
        <dd>{priorityLabel(task.priority)}</dd>
        {task.dueDate !== null && (
          <>
            <dt>Due</dt>
            <dd>{formatDueDate(task.dueDate)}</dd>
          </>
        )}
      </dl>
      {editable && (
        <div className="task-item__actions">
          <select
            aria-label={`Status of ${task.title}`}
            value={task.status}
            onChange={(event) => onChangeStatus(task.id, event.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onDelete(task.id)}>
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
