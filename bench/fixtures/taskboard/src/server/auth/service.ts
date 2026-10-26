import { ConflictError, UnauthorizedError } from '../../shared/errors.ts';
import { validateLoginInput, validateRegisterInput } from '../../shared/validation.ts';
import type { AuthSession, Role } from '../../shared/types.ts';
import { toPublicUser } from '../users/repository.ts';
import type { UserRecord, UserRepository } from '../users/repository.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { signToken } from './token.ts';

export interface AuthServiceOptions {
  secret: string;
  ttlSeconds: number;
  /** Clock in milliseconds; injected so tests control token issue and expiry times. */
  now?: () => number;
}

export class AuthService {
  private readonly users: UserRepository;
  private readonly options: AuthServiceOptions;

  constructor(users: UserRepository, options: AuthServiceOptions) {
    this.users = users;
    this.options = options;
  }

  /** Creates an account. The very first account becomes the admin; everyone else is a member. */
  async register(raw: unknown): Promise<AuthSession> {
    const input = validateRegisterInput(raw);
    if (this.users.findByEmail(input.email) !== undefined) {
      throw new ConflictError('Email is already registered');
    }
    const role: Role = this.users.count() === 0 ? 'admin' : 'member';
    const record = this.users.create(
      { email: input.email, name: input.name, role, passwordHash: await hashPassword(input.password) },
      new Date(this.nowMs()),
    );
    return this.issueSession(record);
  }

  async login(raw: unknown): Promise<AuthSession> {
    const credentials = validateLoginInput(raw);
    const record = this.users.findByEmail(credentials.email);
    // One error for unknown email and wrong password, so the API does not reveal which accounts exist.
    if (record === undefined || !(await verifyPassword(credentials.password, record.passwordHash))) {
      throw new UnauthorizedError('Invalid email or password');
    }
    return this.issueSession(record);
  }

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  private issueSession(record: UserRecord): AuthSession {
    const nowMs = this.nowMs();
    const token = signToken(
      { sub: record.id, email: record.email, role: record.role },
      this.options.secret,
      { ttlSeconds: this.options.ttlSeconds, nowMs },
    );
    return {
      token,
      user: toPublicUser(record),
      expiresAt: new Date(nowMs + this.options.ttlSeconds * 1000).toISOString(),
    };
  }
}
