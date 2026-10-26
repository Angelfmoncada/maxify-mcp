import { MaxifyError } from '../core/errors.js';
import { MAX_BUDGET, MIN_BUDGET } from './types.js';

export const MAX_TASK_CHARS = 4000;
const MAX_REF_CHARS = 1000;

export function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new MaxifyError('INVALID_INPUT', `${field} must be a non-empty string`);
  if (value.length > max) throw new MaxifyError('INVALID_INPUT', `${field} exceeds ${max} characters`);
  return value;
}

export function optionalStrings(value: unknown, field: string, maxItems: number, maxChars = MAX_REF_CHARS): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new MaxifyError('INVALID_INPUT', `${field} must be an array of at most ${maxItems} strings`);
  return value.map((v, i) => requireString(v, `${field}[${i}]`, maxChars));
}

export function clampInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MaxifyError('INVALID_INPUT', `${field} must be a number`);
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function budgetOf(value: unknown, fallback: number): number {
  return clampInt(value, 'budget', MIN_BUDGET, MAX_BUDGET, fallback);
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new MaxifyError('INVALID_INPUT', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optionalBool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new MaxifyError('INVALID_INPUT', `${field} must be a boolean`);
  return value;
}

export function refString(value: unknown, field = 'ref'): string {
  return requireString(value, field, MAX_REF_CHARS).trim();
}
