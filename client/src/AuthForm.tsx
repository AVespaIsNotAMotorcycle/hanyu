import { useState, type FormEvent } from 'react';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthResponse,
  type AuthUser,
  type SignInRequest,
  type SignUpRequest,
} from '@hanyu/shared';
import { postJson } from './api';

type Mode = 'sign-in' | 'sign-up';

export function AuthForm({
  onSignedIn,
}: {
  onSignedIn: (user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    const displayName = String(form.get('displayName') ?? '').trim();
    const body: SignInRequest | SignUpRequest =
      mode === 'sign-up'
        ? { email, password, ...(displayName && { displayName }) }
        : { email, password };

    setPending(true);
    setError(null);
    try {
      const { user } = await postJson<AuthResponse>(`/auth/${mode}`, body);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const signingUp = mode === 'sign-up';
  return (
    <form className="auth" onSubmit={submit}>
      <h2>{signingUp ? 'Create an account' : 'Sign in'}</h2>
      {signingUp && (
        <label>
          Name <span className="hint">(optional)</span>
          <input name="displayName" autoComplete="nickname" maxLength={64} />
        </label>
      )}
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          minLength={signingUp ? PASSWORD_MIN_LENGTH : undefined}
          maxLength={PASSWORD_MAX_LENGTH}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {signingUp ? 'Sign up' : 'Sign in'}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(signingUp ? 'sign-in' : 'sign-up');
          setError(null);
        }}
      >
        {signingUp ? 'Have an account? Sign in' : 'New here? Create an account'}
      </button>
    </form>
  );
}
