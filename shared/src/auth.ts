// Request and response shapes for /api/auth.

export const PASSWORD_MIN_LENGTH = 8;
/** Long passphrases are fine; this only bounds the work done per request. */
export const PASSWORD_MAX_LENGTH = 256;
export const DISPLAY_NAME_MAX_LENGTH = 64;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  settings: {
    dailyNewCards: number;
  };
}

export interface SignUpRequest {
  email: string;
  password: string;
  displayName?: string;
}

export interface SignInRequest {
  email: string;
  password: string;
}

/** Returned by sign-up, sign-in, and GET /api/auth/me. */
export interface AuthResponse {
  user: AuthUser;
}

export interface ErrorResponse {
  error: string;
}

/** Loose check: the address is only used to sign in, never mailed (yet). */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
