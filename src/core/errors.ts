export type MaxifyErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'OUT_OF_ROOT'
  | 'EXCLUDED'
  | 'EXPIRED'
  | 'STALE'
  | 'UNSAFE_ROOT'
  | 'INTERNAL';

/**
 * Expected, user-facing failure. `message` is safe to show to the model and
 * should say how to recover (e.g. which ref to use instead).
 */
export class MaxifyError extends Error {
  readonly code: MaxifyErrorCode;

  constructor(code: MaxifyErrorCode, message: string) {
    super(message);
    this.name = 'MaxifyError';
    this.code = code;
  }
}

export function isMaxifyError(value: unknown): value is MaxifyError {
  return value instanceof MaxifyError;
}
