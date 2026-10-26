import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';

/** Sign-in form with a toggle to register a new account. */
export function LoginForm() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      if (mode === 'login') await login({ email, password });
      else await register({ email, password, name });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
      <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
      {mode === 'register' && (
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      )}
      <label>
        Email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit">{mode === 'login' ? 'Sign in' : 'Register'}</button>
      <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account?' : 'Have an account?'}
      </button>
    </form>
  );
}
