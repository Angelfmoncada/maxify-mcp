import { ForbiddenError, NotFoundError } from '../../shared/errors.ts';
import { validateStatus, validateTaskInput, validateTaskPatch } from '../../shared/validation.ts';
import type { AuthUser, Page, Task } from '../../shared/types.ts';
import type { TaskEventBus } from './events.ts';
import { parseTaskFilter, queryTasks } from './filters.ts';
import type { TaskRepository } from './repository.ts';
import { assertTransition } from './transitions.ts';

/** Owners may modify their own tasks, admins may modify any task, viewers may modify none. */
export function canModify(actor: AuthUser, task: Task): boolean {
  if (actor.role === 'viewer') return false;
  return actor.role === 'admin' || task.ownerId === actor.id;
}

export class TaskService {
  private readonly repository: TaskRepository;
  private readonly events: TaskEventBus;
  private readonly now: () => Date;

  constructor(repository: TaskRepository, events: TaskEventBus, now: () => Date = () => new Date()) {
    this.repository = repository;
    this.events = events;
    this.now = now;
  }

  create(actor: AuthUser, raw: unknown): Task {
    if (actor.role === 'viewer') throw new ForbiddenError('Viewers cannot create tasks');
    const input = validateTaskInput(raw);
    const task = this.repository.create(actor.id, input, this.now());
    this.events.publish({ type: 'task.created', actorId: actor.id, task });
    return task;
  }

  get(id: string): Task {
    const task = this.repository.findById(id);
    if (task === undefined) throw new NotFoundError('Task', id);
    return task;
  }

  /** One page of tasks matching the query-string filter. */
  list(query: Record<string, string>): Page<Task> {
    return queryTasks(this.repository.list(), parseTaskFilter(query), this.now());
  }

  /** Every task, unfiltered; used by the CSV export. */
  listAll(): Task[] {
    return this.repository.list();
  }

  update(actor: AuthUser, id: string, raw: unknown): Task {
    const before = this.getModifiable(actor, id, 'update');
    const changes = validateTaskPatch(raw);
    const task = this.repository.update(id, changes, this.now());
    this.events.publish({ type: 'task.updated', actorId: actor.id, task, before });
    return task;
  }

  updateStatus(actor: AuthUser, id: string, rawStatus: unknown): Task {
    const before = this.getModifiable(actor, id, 'change the status of');
    const status = validateStatus(rawStatus);
    assertTransition(before.status, status);
    const task = this.repository.update(id, { status }, this.now());
    this.events.publish({ type: 'task.status_changed', actorId: actor.id, task, from: before.status });
    return task;
  }

  delete(actor: AuthUser, id: string): void {
    const task = this.getModifiable(actor, id, 'delete');
    this.repository.delete(id);
    this.events.publish({ type: 'task.deleted', actorId: actor.id, task });
  }

  /** Loads a task and checks that `actor` may modify it; `action` completes the 403 message. */
  private getModifiable(actor: AuthUser, id: string, action: string): Task {
    const task = this.get(id);
    if (!canModify(actor, task)) {
      throw new ForbiddenError(`Only the owner or an admin can ${action} this task`);
    }
    return task;
  }
}
