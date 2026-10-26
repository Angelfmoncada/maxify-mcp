import type { TaskStatus } from '@shared/types';
import { statusLabel } from '../utils/format';

const COLORS: Record<TaskStatus, string> = {
  todo: '#6b7280',
  in_progress: '#2563eb',
  in_review: '#d97706',
  done: '#16a34a',
};

export interface StatusBadgeProps {
  status: TaskStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className="status-badge" style={{ backgroundColor: COLORS[status] }}>
      {statusLabel(status)}
    </span>
  );
}
