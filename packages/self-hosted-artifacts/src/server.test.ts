import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.ts';
import { UPLOAD_TIMEOUT } from './store.ts';
import { clockAt, startTestServer, type Verification, verifierAnswering } from './test-support.ts';

const OIDC_TOKEN = 'oidc-token-that-must-never-be-logged';
const NOW = Temporal.Instant.from('2026-06-01T12:00:00Z');
const AUTH = { Authorization: `Bearer ${OIDC_TOKEN}` };

type Answer = { status: number; headers: Record<string, unknown>; bytes: Buffer; body: string };

let rootDir: string;
let storeDir: string;
let now: Temporal.Instant;
let verification: Verification;
let logLines: string[];
let testServer: Awaited<ReturnType<typeof startTestServer>>;
let baseConfig: Config;

const startServer = async (overrides: Partial<Config> = {}) => {
  testServer = await startTestServer({
    config: { ...baseConfig, ...overrides },
    verifier: verifierAnswering(async token =>
      token === OIDC_TOKEN ? verification : { kind: 'rejected', reason: 'bad' },
    ),
    clock: clockAt(() => now),
    onLog: line => logLines.push(line),
  });
};

const sweep = () => testServer.run(testServer.store.sweep);

const answerOf = (res: IncomingMessage) =>
  new Promise<Answer>(resolve => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const bytes = Buffer.concat(chunks);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        bytes,
        body: bytes.toString(),
      });
    });
  });

const openRequest = (method: string, path: string, headers: OutgoingHttpHeaders = {}) =>
  httpRequest({ host: '127.0.0.1', port: testServer.port, method, path, headers });

/** node:http, because fetch normalises paths and refuses to spoof Host. */
const send = (
  method: string,
  path: string,
  { headers = {}, body }: { headers?: OutgoingHttpHeaders; body?: Uint8Array } = {},
) =>
  new Promise<Answer>((resolve, reject) => {
    const req = openRequest(method, path, {
      ...(body === undefined ? {} : { 'Content-Length': body.length }),
      ...headers,
    });
    req.on('response', res => resolve(answerOf(res)));
    req.on('error', reject);
    req.end(body);
  });

const upload = async (
  name: string,
  content: Uint8Array,
  { query = '', headers = AUTH as OutgoingHttpHeaders } = {},
) => send('POST', `/artifacts?name=${name}${query}`, { headers, body: content });

const uploaded = async (name: string, content: Uint8Array, query = '') => {
  const answer = await upload(name, content, { query });
  expect(answer.status).toBe(201);
  const { links } = JSON.parse(answer.body) as { links: Record<string, string> };
  const { pathname } = new URL(Object.values(links)[0] ?? '');
  return { answer, pathname, token: pathname.split('/')[1] ?? '' };
};

const artifactsOnDisk = async () => readdir(join(storeDir, 'artifacts')).catch(() => []);
const tempsOnDisk = async () => readdir(join(storeDir, 'tmp')).catch(() => []);

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-test-'));
  storeDir = join(rootDir, 'store');
  await mkdir(storeDir);
  now = NOW;
  verification = { kind: 'verified', repository: 'fishballapp/private-thing' };
  logLines = [];
  baseConfig = {
    storeDir,
    oidcAudience: 'self-hosted-artifacts',
    oidcRepositoryOwnerId: '42',
    linkBases: { home: 'http://192.0.2.1:8420', tailscale: 'https://files.example' },
    host: '127.0.0.1',
    port: 0,
    defaultRetentionDays: 7,
    maxRetentionDays: 30,
    minFreeBytes: 0,
    maxFileBytes: 1024 * 1024,
  };
});

afterEach(async () => {
  await testServer.stop();
  await rm(rootDir, { recursive: true, force: true });
});

describe('upload and download', () => {
  it('round-trips a file with the exact response and download headers', async () => {
    await startServer();
    const content = randomBytes(64 * 1024);
    const { answer, pathname, token } = await uploaded('liuk-preview.apk', content);

    expect(answer.status).toBe(201);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(answer.body)).toEqual({
      name: 'liuk-preview.apk',
      size: content.length,
      expiresAt: '2026-06-08T12:00:00Z',
      links: {
        home: `http://192.0.2.1:8420/${token}/liuk-preview.apk`,
        tailscale: `https://files.example/${token}/liuk-preview.apk`,
      },
    });

    const download = await send('GET', pathname);
    expect(download.bytes.equals(content)).toBe(true);
    expect(download.headers).toMatchObject({
      'content-length': String(content.length),
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="liuk-preview.apk"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    });

    const head = await send('HEAD', pathname);
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(content.length));
  });

  it('keeps the client-supplied name in metadata, off the disk paths', async () => {
    await startServer();
    const { token } = await uploaded('name.apk', randomBytes(8));
    expect(await artifactsOnDisk()).toEqual([token]);
    expect((await readdir(join(storeDir, 'artifacts', token))).toSorted()).toEqual([
      'data',
      'meta.json',
    ]);
    expect(
      JSON.parse(await readFile(join(storeDir, 'artifacts', token, 'meta.json'), 'utf8')),
    ).toEqual({
      name: 'name.apk',
      size: 8,
      expiresAt: '2026-06-08T12:00:00Z',
    });
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('cuts the connection when the file cannot be read, so a client sees a broken download', async () => {
    await startServer();
    const { pathname, token } = await uploaded('a.apk', new Uint8Array([1, 2, 3]));
    await rm(join(storeDir, 'artifacts', token, 'data'));

    const req = openRequest('GET', pathname);
    const outcome = await new Promise<string>(resolve => {
      req.on('error', () => resolve('cut off'));
      req.on('response', res => {
        res.on('error', () => resolve('cut off'));
        res.on('end', () => resolve('ended'));
        res.resume();
      });
      req.end();
    });

    expect(outcome).toBe('cut off');
    expect(logLines.join('\n')).toContain('download stopped');
  });

  it('accepts an empty file', async () => {
    await startServer();
    const { pathname } = await uploaded('empty.txt', new Uint8Array());
    const download = await send('GET', pathname);
    expect(download.status).toBe(200);
    expect(download.body).toBe('');
  });
});

describe('download routing', () => {
  it.each([
    ['the root', '/'],
    ['a bare token', '/<token>'],
    ['a trailing slash', '/<token>/'],
    ['the wrong filename', '/<token>/other.apk'],
    ['a differently cased filename', '/<token>/NAME.APK'],
    ['a query string', '/<token>/name.apk?x=1'],
    ['an encoded filename', '/<token>/name%2Eapk'],
    ['an extra segment', '/<token>/name.apk/more'],
    ['a short token', '/abc/name.apk'],
    ['a traversal', '/../../etc/passwd'],
    ['an encoded traversal', '/%2e%2e/%2e%2e/etc/passwd'],
    ['a traversal as a token', '/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f../name.apk'],
    ['the store layout', '/artifacts/name.apk'],
    ['a listing', '/artifacts/'],
    ['the upload route', '/artifacts'],
    ['a dotfile token', '/...........................................//name.apk'],
    ['an unknown token', `/${'a'.repeat(43)}/name.apk`],
  ])('answers 404 for %s', async (_, path) => {
    await startServer();
    const { token } = await uploaded('name.apk', randomBytes(8));
    const answer = await send('GET', path.replace('<token>', token));
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toEqual({ error: 'Not found' });
  });

  it('answers 404 for other methods on a file, and on /healthz', async () => {
    await startServer();
    const { pathname } = await uploaded('name.apk', randomBytes(8));
    expect((await send('DELETE', pathname)).status).toBe(404);
    expect((await send('PUT', pathname)).status).toBe(404);
    expect((await send('POST', '/healthz')).status).toBe(404);
    expect((await send('GET', '/artifacts?name=x')).status).toBe(404);
  });
});

describe('upload refusals', () => {
  it.each([
    ['a traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['a plain traversal', '../x'],
    ['a slash', 'a%2Fb'],
    ['a leading dot', '.env'],
    ['a space', 'a%20b.apk'],
    ['a quote', 'a%22b.apk'],
    ['a newline', 'a%0Ab.apk'],
    ['a long name', 'a'.repeat(256)],
    ['an empty name', ''],
  ])('refuses %s as a name without touching the disk', async (_, name) => {
    await startServer();
    const answer = await upload(name, randomBytes(8));
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toMatch(/^name must match/);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it('refuses a missing name', async () => {
    await startServer();
    const answer = await send('POST', '/artifacts', { headers: AUTH, body: randomBytes(8) });
    expect(answer.status).toBe(400);
  });

  it('accepts a 255-character name', async () => {
    await startServer();
    await uploaded('a'.repeat(255), randomBytes(8));
  });

  it.each(['0', '-1', '1.5', 'soon', ''])('refuses retention-days=%s', async days => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), { query: `&retention-days=${days}` });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toMatch(/retention-days/);
  });

  it('checks auth before reading any of the body', async () => {
    await startServer();
    verification = { kind: 'rejected', reason: 'wrong org' };
    // The headers promise a body that never comes: only an answer that ignores it can arrive.
    const answer = await new Promise<Answer>((resolve, reject) => {
      const req = openRequest('POST', '/artifacts?name=a.apk', { ...AUTH, 'Content-Length': 100 });
      req.on('response', res => resolve(answerOf(res)));
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(answer.status).toBe(401);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('answers 401 with a generic message and logs the specific reason', async () => {
    await startServer();
    verification = { kind: 'rejected', reason: 'repository is not private' };
    const answer = await upload('a.apk', randomBytes(8));
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ error: 'Token rejected' });
    expect(logLines.join('\n')).toContain('repository is not private');
  });

  it('answers 401 with no token, a malformed header, or another scheme', async () => {
    await startServer();
    for (const headers of [{}, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }]) {
      const answer = await upload('a.apk', randomBytes(8), { headers });
      expect(answer.status).toBe(401);
    }
  });

  it('answers 503, not 401, when the key set is unavailable', async () => {
    await startServer();
    verification = { kind: 'unavailable', reason: 'could not fetch the JWKS' };
    expect((await upload('a.apk', randomBytes(8))).status).toBe(503);
  });

  it('answers 411 without a Content-Length', async () => {
    await startServer();
    const answer = await new Promise<Answer>((resolve, reject) => {
      const req = openRequest('POST', '/artifacts?name=a.apk', {
        ...AUTH,
        'Transfer-Encoding': 'chunked',
      });
      req.on('response', res => resolve(answerOf(res)));
      req.on('error', reject);
      req.end('hello');
    });
    expect(answer.status).toBe(411);
  });

  it('answers 413 from the Content-Length, before any of the body', async () => {
    await startServer({ maxFileBytes: 10 });
    expect((await upload('a.apk', randomBytes(11))).status).toBe(413);
    expect(await tempsOnDisk()).toEqual([]);
    await uploaded('a.apk', randomBytes(10));
  });

  it('answers 507 when the upload would cross the free-space floor', async () => {
    await startServer({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    const answer = await upload('a.apk', randomBytes(8));
    expect(answer.status).toBe(507);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it('counts the file against the free-space floor', async () => {
    await startServer({ minFreeBytes: 900 });
    Object.assign(testServer.store, { freeBytes: Effect.succeed(1000) });
    expect((await upload('a.apk', randomBytes(100))).status).toBe(201);
    expect((await upload('b.apk', randomBytes(101))).status).toBe(507);
  });
});

describe('links', () => {
  it('come from config, whatever Host and X-Forwarded-* say', async () => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), {
      headers: {
        ...AUTH,
        Host: 'evil.example',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'gopher',
        Forwarded: 'host=evil.example',
      },
    });
    expect(answer.status).toBe(201);
    const { links } = JSON.parse(answer.body) as { links: Record<string, string> };
    expect(Object.keys(links)).toEqual(['home', 'tailscale']);
    expect(answer.body).not.toContain('evil');
    expect(links.home).toMatch(/^http:\/\/192\.0\.2\.1:8420\//);
    expect(links.tailscale).toMatch(/^https:\/\/files\.example\//);
  });
});

describe('retention', () => {
  it('uses the default, honours a request and clamps to the cap', async () => {
    await startServer();
    const expiresAt = async (query: string) => {
      const answer = await upload('a.apk', randomBytes(1), { query });
      return JSON.parse(answer.body).expiresAt;
    };
    expect(await expiresAt('')).toBe('2026-06-08T12:00:00Z');
    expect(await expiresAt('&retention-days=1')).toBe('2026-06-02T12:00:00Z');
    expect(await expiresAt('&retention-days=30')).toBe('2026-07-01T12:00:00Z');
    expect(await expiresAt('&retention-days=31')).toBe('2026-07-01T12:00:00Z');
    expect(await expiresAt(`&retention-days=${'9'.repeat(400)}`)).toBe('2026-07-01T12:00:00Z');
  });

  it('clamps a default above the cap', async () => {
    await startServer({ defaultRetentionDays: 40, maxRetentionDays: 2 });
    const answer = await upload('a.apk', randomBytes(1));
    expect(JSON.parse(answer.body).expiresAt).toBe('2026-06-03T12:00:00Z');
  });
});

describe('a store that goes away', () => {
  it('answers 503 and 404, never creates it, and recovers without a restart', async () => {
    const missing = join(rootDir, 'volume');
    await startServer({ storeDir: missing });

    expect((await send('GET', '/healthz')).status).toBe(503);
    const refused = await upload('a.apk', randomBytes(8));
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: 'The store is missing' });
    expect((await send('GET', `/${'a'.repeat(43)}/a.apk`)).status).toBe(404);
    expect(await sweep()).toEqual({ removedArtifacts: 0, removedTemps: 0 });
    expect(existsSync(missing)).toBe(false);

    await mkdir(missing);
    expect((await send('GET', '/healthz')).status).toBe(200);
    storeDir = missing;
    const { pathname } = await uploaded('a.apk', randomBytes(8));
    expect((await send('GET', pathname)).status).toBe(200);

    await rm(missing, { recursive: true });
    expect((await send('GET', pathname)).status).toBe(404);
    expect((await upload('a.apk', randomBytes(8))).status).toBe(503);
    expect(existsSync(missing)).toBe(false);

    await mkdir(missing);
    await uploaded('a.apk', randomBytes(8));
  });
});

describe('a cancelled upload', () => {
  it('removes its temp straight away and publishes nothing', async () => {
    await startServer();
    const size = 512 * 1024;
    const req = openRequest('POST', '/artifacts?name=cancelled.apk', {
      ...AUTH,
      'Content-Length': size,
    });
    req.on('error', () => undefined);
    req.write(randomBytes(64 * 1024));
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(1));

    req.destroy();

    await vi.waitFor(async () => expect(await tempsOnDisk()).toEqual([]));
    expect(await artifactsOnDisk()).toEqual([]);
    await vi.waitFor(() => expect(logLines.join('\n')).toContain('upload stopped'));
  });
});

describe('a stalled download', () => {
  it('gets cut off', async () => {
    await startServer({ maxFileBytes: 64 * 1024 * 1024 });
    const { pathname } = await uploaded('big.apk', randomBytes(32 * 1024 * 1024));
    expect(testServer.server.timeout).toBe(5 * 60 * 1000);
    testServer.server.timeout = 100;

    const req = openRequest('GET', pathname);
    req.on('error', () => undefined);
    req.on('response', res => {
      res.on('error', () => undefined);
      res.pause();
    });
    req.end();

    await vi.waitFor(() => expect(logLines.join('\n')).toContain('download stopped'));
  });
});

describe('store.put', () => {
  const putFailure = async (chunks: Uint8Array[], size: number) => {
    await startServer();
    return testServer.run(
      testServer.store
        .put({ name: 'a.apk', size, retentionDays: 1, body: Stream.fromIterable(chunks) })
        .pipe(Effect.flip),
    );
  };

  it('refuses a body longer than declared, while streaming', async () => {
    const { reason } = await putFailure([new Uint8Array(4), new Uint8Array(4)], 5);
    expect(reason).toMatch(/longer/);
    expect(await tempsOnDisk()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it('refuses a body shorter than declared', async () => {
    const { reason } = await putFailure([new Uint8Array(4)], 5);
    expect(reason).toMatch(/shorter/);
    expect(await tempsOnDisk()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });
});

describe('expiry', () => {
  it('stops serving at expiry and removes the file at the next sweep', async () => {
    await startServer();
    const { pathname, token } = await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    const kept = await uploaded('b.apk', randomBytes(8), '&retention-days=2');

    now = NOW.add({ hours: 23 });
    expect((await send('GET', pathname)).status).toBe(200);
    expect(await sweep()).toMatchObject({ removedArtifacts: 0 });

    now = NOW.add({ hours: 24 });
    expect((await send('GET', pathname)).status).toBe(404);
    expect((await send('HEAD', pathname)).status).toBe(404);
    expect(await artifactsOnDisk()).toContain(token);

    expect(await sweep()).toMatchObject({ removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([kept.token]);
    expect((await send('GET', kept.pathname)).status).toBe(200);
  });

  it('sweeps what no artifact can be read from', async () => {
    await startServer();
    await mkdir(join(storeDir, 'artifacts'));
    await mkdir(join(storeDir, 'artifacts', 'no-meta'));
    await mkdir(join(storeDir, 'artifacts', 'bad-meta'));
    await writeFile(join(storeDir, 'artifacts', 'bad-meta', 'meta.json'), '{"name":3}');
    await writeFile(join(storeDir, 'artifacts', '.DS_Store'), 'junk');

    expect(await sweep()).toMatchObject({ removedArtifacts: 3 });
    expect(await artifactsOnDisk()).toEqual([]);
  });
});

describe('the temp sweep', () => {
  const makeTemp = async (id: string, age: { minutes: number }) => {
    await mkdir(join(storeDir, 'tmp'), { recursive: true });
    await mkdir(join(storeDir, 'tmp', id));
    await writeFile(join(storeDir, 'tmp', id, 'data'), 'partial');
    const modifiedAt = new Date(Temporal.Now.instant().subtract(age).epochMilliseconds);
    await utimes(join(storeDir, 'tmp', id), modifiedAt, modifiedAt);
  };

  it('removes a temp older than the request timeout, leaving a fresh one', async () => {
    await startServer();
    now = Temporal.Now.instant();
    const timeoutMinutes = Duration.toMinutes(UPLOAD_TIMEOUT);
    await makeTemp('stale', { minutes: timeoutMinutes + 2 });
    await makeTemp('in-flight', { minutes: timeoutMinutes - 1 });
    await makeTemp('fresh', { minutes: 0 });

    expect(await sweep()).toMatchObject({ removedTemps: 1 });
    expect((await tempsOnDisk()).toSorted()).toEqual(['fresh', 'in-flight']);
  });

  it('leaves a real upload in flight alone', async () => {
    await startServer();
    now = Temporal.Now.instant();
    const req = openRequest('POST', '/artifacts?name=slow.apk', {
      ...AUTH,
      'Content-Length': 1024,
    });
    req.on('error', () => undefined);
    req.write(randomBytes(8));
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(1));

    expect(await sweep()).toMatchObject({ removedTemps: 0 });
    expect(await tempsOnDisk()).toHaveLength(1);
    req.destroy();
    await vi.waitFor(async () => expect(await tempsOnDisk()).toEqual([]));
  });
});

describe('/healthz', () => {
  it('answers 200 with the store there', async () => {
    await startServer();
    expect((await send('GET', '/healthz')).status).toBe(200);
  });

  it('answers 503 when storeDir is a file', async () => {
    const file = join(rootDir, 'file');
    await writeFile(file, 'not a directory');
    await startServer({ storeDir: file });
    expect((await send('GET', '/healthz')).status).toBe(503);
  });
});

describe('logs', () => {
  it('never hold a full download token or the OIDC token', async () => {
    await startServer();
    const name = 'a.apk';
    const { pathname, token } = await uploaded(name, randomBytes(8));
    await send('GET', pathname);
    await send('HEAD', pathname);
    await send('GET', `/${token}/wrong.apk`);
    verification = { kind: 'rejected', reason: 'wrong org' };
    await upload(name, randomBytes(8));
    // A failing upload: the store's own directory is in the way, so the error names a path.
    verification = { kind: 'verified', repository: 'fishballapp/private-thing' };
    await rm(join(storeDir, 'tmp'), { recursive: true, force: true });
    await writeFile(join(storeDir, 'tmp'), 'in the way');
    expect((await upload(name, randomBytes(8))).status).toBe(500);

    const logged = logLines.join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(OIDC_TOKEN);
    expect(logged).not.toContain(storeDir);
    expect(logged).toContain(`${token.slice(0, 8)}…`);
    expect(logged).toContain('repository=fishballapp/private-thing name=a.apk size=8');
  });

  it('do not echo a refused name', async () => {
    await startServer();
    await upload('evil%0Aforged-log-line', randomBytes(8));
    expect(logLines.join('\n')).not.toContain('forged-log-line');
  });
});
