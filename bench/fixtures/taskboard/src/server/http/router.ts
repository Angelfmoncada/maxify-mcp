import { AppError, NotFoundError } from '../../shared/errors.ts';
import { errorResponse } from './responses.ts';
import type {
  Handler,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  Middleware,
  RawRequest,
} from './types.ts';

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: Handler;
  middleware: Middleware[];
}

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isHttpMethod(value: string): value is HttpMethod {
  return METHODS.includes(value);
}

/** Matches `/tasks/:id` style patterns. Returns the captured params, or null when the path does not match. */
export function matchPattern(segments: readonly string[], path: string): Record<string, string> | null {
  const actual = splitPath(path);
  if (actual.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, expected] of segments.entries()) {
    const value = actual[index];
    if (value === undefined) return null;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(value);
    } else if (expected !== value) {
      return null;
    }
  }
  return params;
}

/** Runs `middleware` in order around `handler`. A layer may answer early or pass a new request on. */
export function compose(
  middleware: readonly Middleware[],
  handler: Handler,
): (request: HttpRequest) => Promise<HttpResponse> {
  return (request) => {
    const dispatch = (index: number, current: HttpRequest): Promise<HttpResponse> => {
      const layer = middleware[index];
      if (layer === undefined) return Promise.resolve(handler(current));
      return layer(current, (next = current) => dispatch(index + 1, next));
    };
    return dispatch(0, request);
  };
}

function normalizeHeaders(headers: RawRequest['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) result[name.toLowerCase()] = value;
  }
  return result;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly globalMiddleware: Middleware[] = [];

  /** Adds a middleware that wraps every route. */
  use(middleware: Middleware): this {
    this.globalMiddleware.push(middleware);
    return this;
  }

  add(method: HttpMethod, pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    this.routes.push({ method, segments: splitPath(pattern), handler, middleware });
    return this;
  }

  get(pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('GET', pattern, handler, middleware);
  }

  post(pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('POST', pattern, handler, middleware);
  }

  patch(pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('PATCH', pattern, handler, middleware);
  }

  delete(pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    return this.add('DELETE', pattern, handler, middleware);
  }

  /**
   * Routes `raw` to the first registered route that matches both method and path.
   * Never throws: failures are converted to responses by errorResponse.
   */
  async handle(raw: RawRequest): Promise<HttpResponse> {
    try {
      const method = raw.method.toUpperCase();
      if (!isHttpMethod(method)) {
        throw new AppError('METHOD_NOT_ALLOWED', 405, `Method ${raw.method} is not supported`);
      }
      const url = new URL(raw.url, 'http://localhost');
      const candidates = this.routes.flatMap((route) => {
        const params = matchPattern(route.segments, url.pathname);
        return params === null ? [] : [{ route, params }];
      });
      if (candidates.length === 0) throw new NotFoundError('Route', `${method} ${url.pathname}`);
      const hit = candidates.find((candidate) => candidate.route.method === method);
      if (hit === undefined) {
        throw new AppError('METHOD_NOT_ALLOWED', 405, `${method} is not allowed for ${url.pathname}`);
      }
      const request: HttpRequest = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        params: hit.params,
        headers: normalizeHeaders(raw.headers),
        body: raw.body,
      };
      const run = compose([...this.globalMiddleware, ...hit.route.middleware], hit.route.handler);
      return await run(request);
    } catch (error: unknown) {
      return errorResponse(error);
    }
  }
}
