import { isAppError } from '../../shared/errors.ts';
import type { HttpResponse } from './types.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': JSON_CONTENT_TYPE, ...headers }, body };
}

export function ok(body: unknown): HttpResponse {
  return json(200, body);
}

export function created(body: unknown): HttpResponse {
  return json(201, body);
}

export function noContent(): HttpResponse {
  return { status: 204, headers: {}, body: undefined };
}

/** Plain-text (or CSV) response; `body` is sent as is. */
export function text(status: number, body: string, contentType: string): HttpResponse {
  return { status, headers: { 'content-type': contentType }, body };
}

/** Maps any thrown value to a response. Unexpected errors become an opaque 500. */
export function errorResponse(error: unknown): HttpResponse {
  if (isAppError(error)) {
    return json(error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  return json(500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
}
