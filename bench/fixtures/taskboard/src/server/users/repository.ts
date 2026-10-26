import { NotFoundError } from '../../shared/errors.ts';
import { createId } from '../../shared/utils.ts';
import type { Role, User } from '../../shared/types.ts';

/** A stored user. The password hash never leaves the server; see toPublicUser. */
export interface UserRecord extends User {
  passwordHash: string;
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
}

export class UserRepository {
  private readonly records = new Map<string, UserRecord>();

  create(input: NewUser, now: Date = new Date()): UserRecord {
    const record: UserRecord = {
      id: createId('user'),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      passwordHash: input.passwordHash,
      createdAt: now.toISOString(),
    };
    this.records.set(record.id, record);
    return record;
  }

  findById(id: string): UserRecord | undefined {
    return this.records.get(id);
  }

  findByEmail(email: string): UserRecord | undefined {
    const wanted = email.toLowerCase();
    return [...this.records.values()].find((record) => record.email === wanted);
  }

  list(): UserRecord[] {
    return [...this.records.values()];
  }

  /** Replaces the stored record with a copy that has the new role. Tokens already issued keep the old role. */
  setRole(id: string, role: Role): UserRecord {
    const existing = this.records.get(id);
    if (existing === undefined) throw new NotFoundError('User', id);
    const updated: UserRecord = { ...existing, role };
    this.records.set(id, updated);
    return updated;
  }

  count(): number {
    return this.records.size;
  }
}

/** Strips the password hash before a record is sent to a client. */
export function toPublicUser(record: UserRecord): User {
  const { passwordHash: _passwordHash, ...user } = record;
  return user;
}
