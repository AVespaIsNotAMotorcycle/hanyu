import { useEffect, useState } from 'react';
import type { AuthResponse, AuthUser, StudyMode } from '@hanyu/shared';
import { ApiError, getJson, postJson } from './api';
import { AuthForm } from './AuthForm';
import { Decks } from './Decks';
import { LocalDataProvider, useLocalData } from './local/LocalData';
import { LocalStore } from './local/store';
import { StudySession } from './StudySession';
import { SyncIndicator } from './SyncIndicator';

// The last signed-in user, so the app can start without the server (offline).
const USER_KEY = 'hanyu.user';

function cachedUser(): AuthUser | null {
  try {
    const json = localStorage.getItem(USER_KEY);
    return json ? (JSON.parse(json) as AuthUser) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // Storage unavailable: the app just can't start offline.
  }
}

export function App() {
  // undefined: still checking for an existing session.
  const [user, setUserState] = useState<AuthUser | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const setUser = (next: AuthUser | null) => {
    cacheUser(next);
    setUserState(next);
  };

  useEffect(() => {
    getJson<AuthResponse>('/auth/me')
      .then(({ user }) => setUser(user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setUser(null);
          return;
        }
        // Can't reach the server: study offline as the last user, if any.
        const offlineUser = cachedUser();
        if (offlineUser) setUserState(offlineUser);
        else setError(String(err));
      });
  }, []);

  return (
    <main>
      <h1>汉语</h1>
      <p>Learning to read Chinese, one review at a time.</p>
      {error ? (
        <p className="status">Can’t reach the server: {error}</p>
      ) : user === undefined ? (
        <p className="status">Loading…</p>
      ) : user === null ? (
        <AuthForm onSignedIn={setUser} />
      ) : (
        <LocalDataProvider userId={user.id}>
          <Home
            user={user}
            onUserChange={setUser}
            onSignedOut={() => setUser(null)}
          />
        </LocalDataProvider>
      )}
    </main>
  );
}

function Home({
  user,
  onUserChange,
  onSignedOut,
}: {
  user: AuthUser;
  onUserChange: (user: AuthUser) => void;
  onSignedOut: () => void;
}) {
  const { sync, status } = useLocalData();
  const [studying, setStudying] = useState<StudyMode | null>(null);

  // The server session ended (expired, or signed out elsewhere). Ask for a
  // sign-in, keeping this device's reviews: the same account picks them up.
  useEffect(() => {
    if (status.errorStatus === 401) onSignedOut();
  }, [status.errorStatus, onSignedOut]);

  async function signOut() {
    // Send anything recorded here first; the local copy is deleted below.
    await sync.sync();
    const { unsynced } = sync.status;
    if (
      unsynced > 0 &&
      !window.confirm(
        `${unsynced} ${unsynced === 1 ? 'review hasn’t' : 'reviews haven’t'} reached the server yet and will be lost if you sign out. Sign out anyway?`,
      )
    ) {
      return;
    }
    try {
      await postJson('/auth/sign-out');
    } catch {
      // Offline: the server session expires on its own.
    }
    sync.stop();
    onSignedOut();
    // After the provider unmounts and closes the database.
    setTimeout(() => void LocalStore.destroy(user.id).catch(() => {}), 0);
  }

  return (
    <>
      <p>
        Signed in as {user.displayName ?? user.email}.{' '}
        <button type="button" className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
      {studying ? (
        <StudySession
          user={user}
          mode={studying}
          onExit={() => setStudying(null)}
        />
      ) : (
        <Decks user={user} onUserChange={onUserChange} onStudy={setStudying} />
      )}
      <SyncIndicator />
    </>
  );
}
