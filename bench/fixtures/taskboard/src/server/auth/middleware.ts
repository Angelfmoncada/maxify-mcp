import { ForbiddenError, UnauthorizedError } from '../../shared/errors.ts';
import type { AuthUser, Role } from '../../shared/types.ts';
import type { HttpRequest, Middleware } from '../http/types.ts';
import { verifyToken } from './token.ts';

/** Returns the token of an `Authorization: Bearer <token>` header, or null when absent or malformed. */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Rejects the request with 401 unless it carries a valid, unexpired bearer token.
 * On success the verified identity is passed on as `request.user`.
 */
export function requireAuth(secret: string, now: () => number = Date.now): Middleware {
  return async (request, next) => {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) throw new UnauthorizedError('Authorization header is missing');
    const payload = verifyToken(token, secret, now());
    const user: AuthUser = { id: payload.sub, email: payload.email, role: payload.role };
    return next({ ...request, user });
  };
}

/** Allows only the listed roles. Must run after requireAuth. */
export function requireRole(...roles: Role[]): Middleware {
  return async (request, next) => {
    const user = request.user;
    if (user === undefined) throw new UnauthorizedError();
    if (!roles.includes(user.role)) {
      throw new ForbiddenError(`Requires one of the roles: ${roles.join(', ')}`);
    }
    return next();
  };
}

/** The authenticated user of a request; throws 401 when requireAuth did not run. */
export function currentUser(request: HttpRequest): AuthUser {
  if (request.user === undefined) throw new UnauthorizedError();
  return request.user;
}
