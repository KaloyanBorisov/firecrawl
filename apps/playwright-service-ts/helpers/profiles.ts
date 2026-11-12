// Persistent login profiles (self-host). A profile is a Playwright
// storageState JSON (cookies + localStorage) kept at
// ${PROFILES_DIR}/<name>.json. It is loaded into each new browser context and,
// after a successful scrape, written back so refreshed session cookies persist.
//
// Profile contents are login tokens: never log them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ProfileOptions = { name: string; saveChanges?: boolean };

const PROFILE_NAME_RE = /^[a-z0-9._-]{1,64}$/;

export class InvalidProfileNameError extends Error {
  constructor() {
    super('Invalid profile name: must match ^[a-z0-9._-]{1,64}$');
    this.name = 'InvalidProfileNameError';
  }
}

export const isValidProfileName = (name: unknown): name is string =>
  typeof name === 'string' &&
  PROFILE_NAME_RE.test(name) &&
  name !== '.' &&
  name !== '..';

export const profilesDir = (): string =>
  process.env.PROFILES_DIR || '/data/profiles';

export const profilePath = (name: string, dir: string = profilesDir()): string => {
  if (!isValidProfileName(name)) throw new InvalidProfileNameError();
  const base = path.resolve(dir);
  const file = path.resolve(base, `${name}.json`);
  // Defence in depth: the regex already rules out separators.
  if (path.dirname(file) !== base) throw new InvalidProfileNameError();
  return file;
};

/** Returns the parsed storageState, or undefined if the profile does not exist yet. */
export const loadProfile = async (
  name: string,
  dir?: string,
): Promise<object | undefined> => {
  const file = profilePath(name, dir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
    throw new Error(`Profile "${name}" is not a valid storageState file`);
  }
  if (!Array.isArray(parsed.origins)) parsed.origins = [];
  return parsed;
};

/** Atomic write: temp file (mode 600) in the same dir, then rename. */
export const saveProfile = async (
  name: string,
  state: object,
  dir?: string,
): Promise<void> => {
  const file = profilePath(name, dir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

const LOGIN_PATH_RE =
  /(^|[/_-])(log[-_]?in|sign[-_]?in|sign[-_]?up|auth|oauth2?|sso|session\/new|accounts?\/login|i\/flow\/login)([/_.?-]|$)/i;

/** Heuristic: did the scrape land on a login / sign-in page? */
export const looksLikeLoginUrl = (landedUrl: string | null | undefined): boolean => {
  if (!landedUrl) return false;
  let u: URL;
  try {
    u = new URL(landedUrl);
  } catch {
    return false;
  }
  if (/^(login|signin|auth|accounts|sso|id)\./i.test(u.hostname)) return true;
  return LOGIN_PATH_RE.test(u.pathname) || LOGIN_PATH_RE.test(u.hash);
};

/** Persist only after a clean 200 that did not end on a login page. */
export const shouldSaveProfile = (
  profile: ProfileOptions | undefined,
  status: number | null | undefined,
  landedUrl: string | null | undefined,
): boolean =>
  !!profile &&
  profile.saveChanges !== false &&
  status === 200 &&
  !looksLikeLoginUrl(landedUrl);

// Per-profile in-process lock around profile file I/O, so concurrent scrapes
// of the same profile never interleave a read with a write or race two saves.
// Scrapes themselves still run in parallel (last successful save wins).
const profileLocks = new Map<string, Promise<void>>();

export const withProfileLock = async <T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = profileLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => current);
  profileLocks.set(name, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (profileLocks.get(name) === chained) profileLocks.delete(name);
  }
};

const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key']);

/** Copy of headers safe for logging (credential values replaced). */
export const redactHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined =>
  headers &&
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v,
    ]),
  );
