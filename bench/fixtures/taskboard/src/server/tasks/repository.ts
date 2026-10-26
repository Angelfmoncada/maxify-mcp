import { NotFoundError } from '../../shared/errors.ts';
import { createId } from '../../shared/utils.ts';
import type { Task, TaskInput } from '../../shared/types.ts';

/** Fields that may change after creation. Identity, owner and timestamps are managed by the repository. */
export type TaskChanges = Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate'>>;

/** In-memory task store. Stored tasks are never mutated; updates replace them with a new object. */
export class TaskRepository {
  private readonly tasks = new Map<string, Task>();

  create(ownerId: string, input: TaskInput, now: Date): Task {
    const timestamp = now.toISOString();
    const task: Task = {
      id: createId('task'),
      title: input.title,
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority ?? 'medium',
      ownerId,
      dueDate: input.dueDate ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  findById(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** All tasks in creation order. */
  list(): Task[] {
    return [...this.tasks.values()];
  }

  update(id: string, changes: TaskChanges, now: Date): Task {
    const existing = this.tasks.get(id);
    if (existing === undefined) throw new NotFoundError('Task', id);
    const updated: Task = { ...existing, ...changes, updatedAt: now.toISOString() };
    this.tasks.set(id, updated);
    return updated;
  }

  /** Returns true when a task was removed. */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  count(): number {
    return this.tasks.size;
  }
}
