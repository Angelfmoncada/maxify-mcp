import { currentUser, requireRole } from '../auth/middleware.ts';
import { created, noContent, ok, text } from '../http/responses.ts';
import type { Router } from '../http/router.ts';
import type { Handler, Middleware } from '../http/types.ts';
import { tasksToCsv } from './export.ts';
import type { TaskService } from './service.ts';

export interface TaskRouteDeps {
  service: TaskService;
  authenticate: Middleware;
}

export function listTasksHandler(service: TaskService): Handler {
  return (request) => ok(service.list(request.query));
}

export function getTaskHandler(service: TaskService): Handler {
  return (request) => ok(service.get(request.params.id ?? ''));
}

export function createTaskHandler(service: TaskService): Handler {
  return (request) => created(service.create(currentUser(request), request.body));
}

export function updateTaskHandler(service: TaskService): Handler {
  return (request) => ok(service.update(currentUser(request), request.params.id ?? '', request.body));
}

export function changeStatusHandler(service: TaskService): Handler {
  return (request) =>
    ok(service.updateStatus(currentUser(request), request.params.id ?? '', request.body));
}

export function deleteTaskHandler(service: TaskService): Handler {
  return (request) => {
    service.delete(currentUser(request), request.params.id ?? '');
    return noContent();
  };
}

export function exportTasksHandler(service: TaskService): Handler {
  return () => text(200, tasksToCsv(service.listAll()), 'text/csv; charset=utf-8');
}

export function registerTaskRoutes(router: Router, deps: TaskRouteDeps): void {
  const { service, authenticate } = deps;
  const canWrite = requireRole('admin', 'member');

  router.get('/tasks', listTasksHandler(service), [authenticate]);
  router.post('/tasks', createTaskHandler(service), [authenticate, canWrite]);
  // Registered before '/tasks/:id' so that "export.csv" is not captured as a task id.
  router.get('/tasks/export.csv', exportTasksHandler(service), [authenticate]);
  router.get('/tasks/:id', getTaskHandler(service), [authenticate]);
  router.patch('/tasks/:id', updateTaskHandler(service), [authenticate, canWrite]);
  router.post('/tasks/:id/status', changeStatusHandler(service), [authenticate, canWrite]);
  router.delete('/tasks/:id', deleteTaskHandler(service), [authenticate, canWrite]);
}
