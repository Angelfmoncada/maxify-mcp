import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginCredentials, RegisterInput, Role, Task, User } from '@shared/types';
import type { ApiClient } from '../api/client';

const TOKEN_STORAGE_KEY = 'taskboard.token';

/** The token the API client sends; kept in localStorage so a reload keeps the session. */
export function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until the page closes.
  }
}

export interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  login(credentials: LoginCredentials): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): void;
  hasRole(...roles: Role[]): boolean;
  /** Mirrors the server rule: owners and admins may modify a task, viewers never. */
  canModify(task: Task): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  client: ApiClient;
  children: ReactNode;
}

export function AuthProvider({ client, children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(readStoredToken() !== null);

  useEffect(() => {
    if (readStoredToken() === null) return;
    client
      .me()
      .then(setUser)
      .catch(() => storeToken(null))
      .finally(() => setLoading(false));
  }, [client]);

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      const session = await client.login(credentials);
      storeToken(session.token);
      setUser(session.user);
    },
    [client],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const session = await client.register(input);
      storeToken(session.token);
      setUser(session.user);
    },
    [client],
  );

  const logout = useCallback(() => {
    storeToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      loading,
      login,
      register,
      logout,
      hasRole: (...roles) => user !== null && roles.includes(user.role),
      canModify: (task) => {
        if (user === null || user.role === 'viewer') return false;
        return user.role === 'admin' || task.ownerId === user.id;
      },
    }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
