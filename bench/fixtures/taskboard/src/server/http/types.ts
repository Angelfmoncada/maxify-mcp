import type { AuthUser } from '../../shared/types.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request as delivered by a transport (the Node adapter, or a test) before routing. */
export interface RawRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: unknown;
  /** Set by requireAuth after the bearer token has been verified. */
  user?: AuthUser;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Continues the chain; pass a modified request to hand it to the next layer. */
export type Next = (request?: HttpRequest) => Promise<HttpResponse>;

export type Middleware = (request: HttpRequest, next: Next) => Promise<HttpResponse>;
