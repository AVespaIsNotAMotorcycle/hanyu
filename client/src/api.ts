import type { ErrorResponse } from '@hanyu/shared';

/** An API error, carrying the server's `{ error }` message and status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ErrorResponse | null;
    throw new ApiError(
      data?.error ?? `${method} /api${path} failed with ${res.status}`,
      res.status,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

/** The browser's IANA time zone, which the server uses to find "today". */
export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
