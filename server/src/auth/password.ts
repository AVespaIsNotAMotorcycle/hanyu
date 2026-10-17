import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// scrypt from node:crypto: memory-hard, and needs no native build on Heroku.
// Hashes store their own parameters, so these can be raised later without
// invalidating existing passwords.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  { N, r, p }: typeof PARAMS,
  keyLength: number,
): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; leave headroom over Node's 32 MiB default.
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (base64 salt and hash). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, PARAMS, KEY_LENGTH);
  const { N, r, p } = PARAMS;
  return [
    'scrypt',
    N,
    r,
    p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const key = await derive(
    password,
    Buffer.from(salt, 'base64'),
    params,
    expected.length,
  );
  return timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real check, so sign-in for an unknown email takes
 * as long as a wrong password and doesn't reveal which emails have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy password for timing');
  await verifyPassword(password, await dummyHash);
  return false;
}
