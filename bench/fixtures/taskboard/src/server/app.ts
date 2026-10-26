import { requireAuth } from './auth/middleware.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { AuthService } from './auth/service.ts';
import { loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { ok } from './http/responses.ts';
import { Router } from './http/router.ts';
import type { HttpResponse, RawRequest } from './http/types.ts';
import { loadPlugins } from './plugins/loader.ts';
import { TaskEventBus } from './tasks/events.ts';
import { TaskRepository } from './tasks/repository.ts';
import { registerTaskRoutes } from './tasks/routes.ts';
import { TaskService } from './tasks/service.ts';
import { UserRepository } from './users/repository.ts';
import { createLogger } from './util/logger.ts';
import type { Logger } from './util/logger.ts';

export interface AppOptions {
  /** Environment variables used to build the config; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Overrides applied on top of the environment-derived config. */
  config?: Partial<ServerConfig>;
  /** Clock; tests pass a controllable one so tokens and timestamps are deterministic. */
  now?: () => Date;
  logger?: Logger;
}

export interface App {
  config: ServerConfig;
  logger: Logger;
  events: TaskEventBus;
  router: Router;
  repositories: { users: UserRepository; tasks: TaskRepository };
  services: { auth: AuthService; tasks: TaskService };
  handle(request: RawRequest): Promise<HttpResponse>;
}

/** Wires repositories, services, middleware and routes. No sockets are opened here. */
export function createApp(options: AppOptions = {}): App {
  const config: ServerConfig = { ...loadConfig(options.env), ...options.config };
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? createLogger('info');
  const events = new TaskEventBus((error) => logger.error('event listener failed', { error: String(error) }));

  const users = new UserRepository();
  const taskRepository = new TaskRepository();
  const auth = new AuthService(users, {
    secret: config.tokenSecret,
    ttlSeconds: config.tokenTtlSeconds,
    now: () => now().getTime(),
  });
  const tasks = new TaskService(taskRepository, events, now);
  const authenticate = requireAuth(config.tokenSecret, () => now().getTime());

  const router = new Router();
  router.get('/health', () => ok({ status: 'ok' }));
  registerAuthRoutes(router, { auth, users, authenticate });
  registerTaskRoutes(router, { service: tasks, authenticate });

  return {
    config,
    logger,
    events,
    router,
    repositories: { users, tasks: taskRepository },
    services: { auth, tasks },
    handle: (request) => router.handle(request),
  };
}

/** Loads the plugins named in the config. Returns the functions that tear them down again. */
export function startPlugins(app: App): Promise<Array<() => void>> {
  return loadPlugins(app.config.plugins, {
    events: app.events,
    logger: app.logger,
    config: app.config,
  });
}
