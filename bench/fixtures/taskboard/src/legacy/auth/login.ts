/**
 * Cookie login of the old monolith: md5 passwords, session cookie, no roles.
 * Superseded by AuthService; do not import from new code.
 */
import { createHash } from 'node:crypto';
import { signToken, verifyToken } from './session-token.ts';

export interface LegacyAccount {
  id: string;
  email: string;
  md5Password: string;
}

const accounts = new Map<string, LegacyAccount>();

export function legacyRegister(email: string, password: string): LegacyAccount {
  const account: LegacyAccount = {
    id: `u${accounts.size + 1}`,
    email,
    md5Password: createHash('md5').update(password).digest('hex'),
  };
  accounts.set(email, account);
  return account;
}

/** Returns the Set-Cookie value for a successful login, or null. */
export function legacyLogin(email: string, password: string, secret: string): string | null {
  const account = accounts.get(email);
  if (account === undefined) return null;
  const digest = createHash('md5').update(password).digest('hex');
  if (digest !== account.md5Password) return null;
  return `session=${signToken(account.id, secret)}; HttpOnly; Path=/`;
}

export function legacyCurrentUser(cookie: string, secret: string): LegacyAccount | null {
  const raw = /session=([^;]+)/.exec(cookie)?.[1];
  if (raw === undefined) return null;
  const token = verifyToken(raw, secret);
  if (token === null) return null;
  return [...accounts.values()].find((account) => account.id === token.userId) ?? null;
}
