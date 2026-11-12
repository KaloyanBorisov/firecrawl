import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InvalidProfileNameError,
  isValidProfileName,
  loadProfile,
  looksLikeLoginUrl,
  profilePath,
  redactHeaders,
  saveProfile,
  shouldSaveProfile,
  withProfileLock,
} from './profiles';

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'profiles-'));

test('accepts valid profile names', () => {
  for (const name of ['stocktwits', 'x', 'reddit.com', 'a_b-c.1', 'a'.repeat(64)]) {
    assert.equal(isValidProfileName(name), true, name);
  }
});

test('rejects invalid profile names', () => {
  for (const name of [
    '',
    '../x',
    '..',
    '.',
    'a/b',
    'a\\b',
    'Stocktwits',
    'X',
    'a'.repeat(65),
    'with space',
    'nul\0',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isValidProfileName(name), false, String(name));
  }
  assert.throws(() => profilePath('../x', '/data/profiles'), InvalidProfileNameError);
});

test('profilePath resolves inside the profiles dir', () => {
  assert.equal(profilePath('x', '/data/profiles'), '/data/profiles/x.json');
});

test('missing profile loads as undefined; save then load round-trips with mode 600', async () => {
  const dir = await tmpDir();
  assert.equal(await loadProfile('nope', dir), undefined);
  const state = { cookies: [{ name: 'a', value: 'b', domain: '.e.com', path: '/' }], origins: [] };
  await saveProfile('site', state, dir);
  assert.deepEqual(await loadProfile('site', dir), state);
  const st = await fs.stat(path.join(dir, 'site.json'));
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('loadProfile rejects a file that is not a storageState', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'bad.json'), '{"foo":1}');
  await assert.rejects(loadProfile('bad', dir));
});

test('does not save on non-200', () => {
  const p = { name: 'x', saveChanges: true };
  assert.equal(shouldSaveProfile(p, 200, 'https://stocktwits.com/symbol/NVDA'), true);
  for (const status of [null, 201, 301, 302, 401, 403, 404, 429, 500]) {
    assert.equal(shouldSaveProfile(p, status, 'https://stocktwits.com/symbol/NVDA'), false, String(status));
  }
});

test('does not save when saveChanges is false or no profile', () => {
  assert.equal(shouldSaveProfile({ name: 'x', saveChanges: false }, 200, 'https://e.com/'), false);
  assert.equal(shouldSaveProfile(undefined, 200, 'https://e.com/'), false);
  assert.equal(shouldSaveProfile({ name: 'x' }, 200, 'https://e.com/'), true);
});

test('does not save on login redirect', () => {
  const p = { name: 'x' };
  for (const url of [
    'https://stocktwits.com/signin?next=/symbol/NVDA',
    'https://www.reddit.com/login/?dest=https%3A%2F%2Fwww.reddit.com%2F',
    'https://x.com/i/flow/login',
    'https://example.com/users/sign_in',
    'https://example.com/account/log-in',
    'https://accounts.google.com/ServiceLogin',
    'https://login.example.com/',
    'https://example.com/auth/callback',
    'https://example.com/session/new',
    'https://app.example.com/#/login',
  ]) {
    assert.equal(looksLikeLoginUrl(url), true, url);
    assert.equal(shouldSaveProfile(p, 200, url), false, url);
  }
  for (const url of [
    'https://stocktwits.com/symbol/NVDA',
    'https://example.com/authors/jane',
    'https://www.reddit.com/r/stocks/',
    'https://x.com/home',
  ]) {
    assert.equal(looksLikeLoginUrl(url), false, url);
  }
});

test('withProfileLock serializes same-name work, not different names', async () => {
  const log: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    withProfileLock('a', async () => { log.push('a1-start'); await sleep(30); log.push('a1-end'); }),
    withProfileLock('a', async () => { log.push('a2-start'); log.push('a2-end'); }),
    withProfileLock('b', async () => { log.push('b-start'); log.push('b-end'); }),
  ]);
  assert.ok(log.indexOf('a2-start') > log.indexOf('a1-end'));
  assert.ok(log.indexOf('b-start') < log.indexOf('a1-end'));
  // A throwing holder still releases the lock.
  await assert.rejects(withProfileLock('c', async () => { throw new Error('boom'); }));
  assert.equal(await withProfileLock('c', async () => 1), 1);
});

test('redactHeaders hides credentials', () => {
  assert.deepEqual(
    redactHeaders({ Cookie: 'sid=secret', authorization: 'Bearer t', 'User-Agent': 'ua' }),
    { Cookie: '[REDACTED]', authorization: '[REDACTED]', 'User-Agent': 'ua' },
  );
});
