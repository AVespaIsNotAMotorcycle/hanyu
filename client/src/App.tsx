import { useEffect, useState } from 'react';
import type { AuthResponse, AuthUser, HealthResponse } from '@hanyu/shared';
import { ApiError, getJson, postJson } from './api';
import { AuthForm } from './AuthForm';

export function App() {
  // undefined: still checking for an existing session.
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<AuthResponse>('/auth/me')
      .then(({ user }) => setUser(user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setError(String(err));
      });
  }, []);

  return (
    <main>
      <h1>汉语</h1>
      <p>Learning to read Chinese, one review at a time.</p>
      {error ? (
        <p className="status">API unreachable: {error}</p>
      ) : user === undefined ? (
        <p className="status">Checking API…</p>
      ) : user === null ? (
        <AuthForm onSignedIn={setUser} />
      ) : (
        <Home user={user} onSignedOut={() => setUser(null)} />
      )}
    </main>
  );
}

function Home({
  user,
  onSignedOut,
}: {
  user: AuthUser;
  onSignedOut: () => void;
}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    getJson<HealthResponse>('/health')
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  async function signOut() {
    await postJson('/auth/sign-out');
    onSignedOut();
  }

  return (
    <>
      <p>
        Signed in as {user.displayName ?? user.email}.{' '}
        <button type="button" className="link" onClick={signOut}>
          Sign out
        </button>
      </p>
      <p className="status">
        {health
          ? `API ${health.status} · database ${health.db}`
          : 'Checking API…'}
      </p>
    </>
  );
}
