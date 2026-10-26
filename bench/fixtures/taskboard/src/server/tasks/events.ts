import type { Task, TaskStatus } from '../../shared/types.ts';

export type TaskEvent =
  | { type: 'task.created'; actorId: string; task: Task }
  | { type: 'task.updated'; actorId: string; task: Task; before: Task }
  | { type: 'task.status_changed'; actorId: string; task: Task; from: TaskStatus }
  | { type: 'task.deleted'; actorId: string; task: Task };

export type TaskEventListener = (event: TaskEvent) => void;

/** In-process publish/subscribe used by plugins. A failing listener never breaks the request. */
export class TaskEventBus {
  private listeners: readonly TaskEventListener[] = [];
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => undefined) {
    this.onListenerError = onListenerError;
  }

  /** Registers a listener and returns a function that removes it again. */
  subscribe(listener: TaskEventListener): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((existing) => existing !== listener);
    };
  }

  publish(event: TaskEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.onListenerError(error);
      }
    }
  }
}
