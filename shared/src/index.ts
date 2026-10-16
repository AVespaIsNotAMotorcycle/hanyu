// Code shared by the client and server: API types now, FSRS scheduling later.

export interface HealthResponse {
  status: 'ok';
  db: 'connected' | 'disconnected';
}
