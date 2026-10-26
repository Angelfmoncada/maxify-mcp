import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.ts';
import type { Page } from './types.ts';

/** Prefixed random identifier such as `task_3f2a9c...`. Works in Node and in browsers. */
export function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Returns one page of `items`. `page` is 1-based; `pageSize` is clamped to [1, MAX_PAGE_SIZE]. */
export function paginate<T>(
  items: readonly T[],
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const size = clamp(Math.trunc(pageSize), 1, MAX_PAGE_SIZE);
  const current = Math.max(Math.trunc(page), 1);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), total: items.length, page: current, pageSize: size };
}
