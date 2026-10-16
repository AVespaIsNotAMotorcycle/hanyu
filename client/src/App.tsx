import { useEffect, useState } from 'react';
import type { HealthResponse } from '@hanyu/shared';
import { getJson } from './api';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<HealthResponse>('/health')
      .then(setHealth)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  return (
    <main>
      <h1>汉语</h1>
      <p>Learning to read Chinese, one review at a time.</p>
      <p className="status">
        {error
          ? `API unreachable: ${error}`
          : health
            ? `API ${health.status} · database ${health.db}`
            : 'Checking API…'}
      </p>
    </main>
  );
}
