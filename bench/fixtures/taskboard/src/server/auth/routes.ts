import { NotFoundError } from '../../shared/errors.ts';
import { validateRole } from '../../shared/validation.ts';
import { created, ok } from '../http/responses.ts';
import type { Router } from '../http/router.ts';
import type { Middleware } from '../http/types.ts';
import { toPublicUser } from '../users/repository.ts';
import type { UserRepository } from '../users/repository.ts';
import { currentUser, requireRole } from './middleware.ts';
import type { AuthService } from './service.ts';

export interface AuthRouteDeps {
  auth: AuthService;
  users: UserRepository;
  authenticate: Middleware;
}

export function registerAuthRoutes(router: Router, deps: AuthRouteDeps): void {
  router.post('/auth/register', async (request) => created(await deps.auth.register(request.body)));
  router.post('/auth/login', async (request) => ok(await deps.auth.login(request.body)));

  router.get(
    '/auth/me',
    (request) => {
      const user = currentUser(request);
      const record = deps.users.findById(user.id);
      if (record === undefined) throw new NotFoundError('User', user.id);
      return ok(toPublicUser(record));
    },
    [deps.authenticate],
  );

  router.get('/users', () => ok(deps.users.list().map(toPublicUser)), [
    deps.authenticate,
    requireRole('admin'),
  ]);

  // The role is embedded in the bearer token, so a change applies from the user's next login.
  router.patch(
    '/users/:id/role',
    (request) => {
      const role = validateRole(request.body);
      return ok(toPublicUser(deps.users.setRole(request.params.id ?? '', role)));
    },
    [deps.authenticate, requireRole('admin')],
  );
}
