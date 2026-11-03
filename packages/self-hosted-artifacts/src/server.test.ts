import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import type * as Path from 'effect/Path';
import * as PlatformError from 'effect/PlatformError';
import * as Sink from 'effect/Sink';
import * as Stream from 'effect/Stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.ts';
import { UPLOAD_TIMEOUT } from './store.ts';
import { clockAt, startTestServer, type Verification, verifierAnswering } from './test-support.ts';

const OIDC_TOKEN = 'oidc-token-that-must-never-be-logged';
const NOW = Temporal.Instant.from('2026-06-01T12:00:00Z');
const AUTH = { Authorization: `Bearer ${OIDC_TOKEN}` };
const SCOPE = { repositoryId: '7', runId: '100', runAttempt: '1' };
const VERIFIED = {
  kind: 'verified',
  repository: 'fishballapp/private-thing',
  scope: SCOPE,
} as const;

type Answer = { status: number; headers: Record<string, unknown>; bytes: Buffer; body: string };

let rootDir: string;
let storeDir: string;
let now: Temporal.Instant;
let verification: Verification;
let logLines: string[];
let testServer: Awaited<ReturnType<typeof startTestServer>>;
let baseConfig: Config;

const startServer = async (
  overrides: Partial<Config> = {},
  storeServices?: Layer.Layer<FileSystem.FileSystem | Path.Path>,
) => {
  testServer = await startTestServer({
    config: { ...baseConfig, ...overrides },
    verifier: verifierAnswering(async token =>
      token === OIDC_TOKEN ? verification : { kind: 'rejected', reason: 'bad' },
    ),
    clock: clockAt(() => now),
    onLog: line => logLines.push(line),
    ...(storeServices === undefined ? {} : { storeServices }),
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

const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

const stored = (answer: Answer) => {
  const { id, links } = JSON.parse(answer.body) as { id: string; links: Record<string, string> };
  const { pathname } = new URL(Object.values(links)[0] ?? '');
  return { id, pathname, token: pathname.split('/')[1] ?? '' };
};

const uploaded = async (name: string, content: Uint8Array, query = '') => {
  const answer = await upload(name, content, { query });
  expect(answer.status).toBe(201);
  return { answer, ...stored(answer) };
};

const artifactsOnDisk = async () => readdir(join(storeDir, 'artifacts')).catch(() => []);
const tempsOnDisk = async () => readdir(join(storeDir, 'tmp')).catch(() => []);
const runsDir = () => join(storeDir, 'runs');
const namesDir = ({ repositoryId, runId, runAttempt } = SCOPE) =>
  join(runsDir(), repositoryId, runId, runAttempt);
const namesOnDisk = async (scope = SCOPE) => readdir(namesDir(scope)).catch(() => []);
const nameFile = (name: string, scope = SCOPE) => join(namesDir(scope), `${sha256(name)}.json`);

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-test-'));
  storeDir = join(rootDir, 'store');
  await mkdir(storeDir);
  now = NOW;
  verification = VERIFIED;
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
      id: token,
      name: 'liuk-preview.apk',
      size: content.length,
      digest: sha256(content),
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
    const content = randomBytes(8);
    const { token } = await uploaded('name.apk', content);
    expect(await artifactsOnDisk()).toEqual([token]);
    expect((await readdir(join(storeDir, 'artifacts', token))).toSorted()).toEqual([
      'data',
      'meta.json',
    ]);
    const meta = JSON.parse(
      await readFile(join(storeDir, 'artifacts', token, 'meta.json'), 'utf8'),
    );
    expect(meta).toEqual({
      id: token,
      ...SCOPE,
      name: 'name.apk',
      size: 8,
      digest: sha256(content),
      expiresAt: '2026-06-08T12:00:00Z',
    });
    expect(await namesOnDisk()).toEqual([`${sha256('name.apk')}.json`]);
    expect(JSON.parse(await readFile(nameFile('name.apk'), 'utf8'))).toEqual(meta);
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

  it('answers 404 for a token with its case changed, whatever the disk folds', async () => {
    await startServer();
    const { pathname, token } = await uploaded('name.apk', randomBytes(8));
    const flipped = token.replace(/[a-zA-Z]/, letter =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    );
    expect((await send('GET', pathname.replace(token, flipped))).status).toBe(404);
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

  it.each(['ABC', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), ''])(
    'refuses digest=%s',
    async digest => {
      await startServer();
      const answer = await upload('a.apk', randomBytes(8), { query: `&digest=${digest}` });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body).error).toMatch(/^digest must be/);
      expect(await artifactsOnDisk()).toEqual([]);
    },
  );

  it.each(['yes', 'TRUE', '1', ''])('refuses overwrite=%s', async overwrite => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), { query: `&overwrite=${overwrite}` });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toMatch(/^overwrite must be/);
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
      const answer = await upload(`${crypto.randomUUID()}.apk`, randomBytes(1), { query });
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
    expect(await sweep()).toEqual({ removedNames: 0, removedArtifacts: 0, removedTemps: 0 });
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

describe('a file shorter than its size', () => {
  it('breaks the connection rather than leaving the client waiting', async () => {
    await startServer();
    const { pathname, token } = await uploaded('a.apk', randomBytes(1000));
    await truncate(join(storeDir, 'artifacts', token, 'data'), 100);
    await expect(
      fetch(`http://127.0.0.1:${testServer.port}${pathname}`, {
        signal: AbortSignal.timeout(5_000),
      }).then(response => response.arrayBuffer()),
    ).rejects.toMatchObject({ name: 'TypeError' });
    expect(logLines.join('\n')).toContain('download stopped');
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
        .put({
          scope: SCOPE,
          name: 'a.apk',
          size,
          digest: undefined,
          overwrite: false,
          retentionDays: 1,
          body: Stream.fromIterable(chunks),
        })
        .pipe(Effect.flip),
    );
  };

  it('refuses a body longer than declared, while streaming', async () => {
    const failure = await putFailure([new Uint8Array(4), new Uint8Array(4)], 5);
    expect(failure).toMatchObject({ reason: expect.stringMatching(/longer/) });
    expect(await tempsOnDisk()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it('refuses a body shorter than declared', async () => {
    const failure = await putFailure([new Uint8Array(4)], 5);
    expect(failure).toMatchObject({ reason: expect.stringMatching(/shorter/) });
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

describe('a name in a run attempt', () => {
  const put = (name: string, content: Uint8Array, query = '') =>
    upload(name, content, { query: `&digest=${sha256(content)}${query}` });

  it('refuses a second upload with other content, leaving the first as it was', async () => {
    await startServer();
    const first = randomBytes(8);
    const { pathname } = stored(await put('a.apk', first));

    const answer = await put('a.apk', randomBytes(8));

    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body).error).toMatch(/already exists on the workflow run/);
    expect((await send('GET', pathname)).bytes.equals(first)).toBe(true);
    expect(await artifactsOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('refuses with a digest before reading any of the body', async () => {
    await startServer();
    await put('a.apk', randomBytes(8));
    const answer = await new Promise<Answer>((resolve, reject) => {
      const req = openRequest('POST', `/artifacts?name=a.apk&digest=${sha256('other')}`, {
        ...AUTH,
        'Content-Length': 100,
      });
      req.on('response', res => resolve(answerOf(res)));
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(answer.status).toBe(409);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('refuses without a digest once it has the body to compare', async () => {
    await startServer();
    await uploaded('a.apk', randomBytes(8));
    expect((await upload('a.apk', randomBytes(8))).status).toBe(409);
    expect(await artifactsOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('with overwrite, replaces it: a new ID, and the old link stops working', async () => {
    await startServer();
    const old = stored(await put('a.apk', randomBytes(8)));
    const content = randomBytes(8);

    const answer = await put('a.apk', content, '&overwrite=true');

    expect(answer.status).toBe(201);
    const replacement = stored(answer);
    expect(replacement.id).not.toBe(old.id);
    expect((await send('GET', old.pathname)).status).toBe(404);
    expect((await send('GET', replacement.pathname)).bytes.equals(content)).toBe(true);
    expect(await artifactsOnDisk()).toEqual([replacement.id]);
    expect(await namesOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('with overwrite and nothing there, just stores it', async () => {
    await startServer();
    expect((await put('a.apk', randomBytes(8), '&overwrite=true')).status).toBe(201);
  });

  it('keeps the old artifact when the upload meant to replace it fails', async () => {
    await startServer();
    const old = stored(await put('a.apk', randomBytes(8)));
    const answer = await upload('a.apk', randomBytes(8), {
      query: `&digest=${sha256('other')}&overwrite=true`,
    });
    expect(answer.status).toBe(422);
    expect((await send('GET', old.pathname)).status).toBe(200);
  });

  it.each([
    ['without overwrite', ''],
    ['with overwrite', '&overwrite=true'],
  ])('answers a retried upload %s with the same artifact', async (_, query) => {
    await startServer();
    const content = randomBytes(8);
    const first = await put('a.apk', content);

    const retry = await put('a.apk', content, query);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body)).toEqual(JSON.parse(first.body));
    expect((await send('GET', stored(first).pathname)).bytes.equals(content)).toBe(true);
    expect(await artifactsOnDisk()).toEqual([stored(first).id]);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('answers a retry even when the disk could not take it again', async () => {
    await startServer({ minFreeBytes: 900 });
    Object.assign(testServer.store, { freeBytes: Effect.succeed(1000) });
    const content = randomBytes(8);
    const { id } = stored(await put('a.apk', content));
    Object.assign(testServer.store, { freeBytes: Effect.succeed(0) });
    const retry = await put('a.apk', content);
    expect(retry.status).toBe(200);
    expect(stored(retry).id).toBe(id);
  });

  it('recognises a retry with no digest sent, by what the body hashes to', async () => {
    await startServer();
    const content = randomBytes(8);
    const first = await uploaded('a.apk', content);
    const retry = await upload('a.apk', content);
    expect(retry.status).toBe(200);
    expect(stored(retry).id).toBe(first.id);
    expect(await artifactsOnDisk()).toEqual([first.id]);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('refuses a body that is not what its digest says, storing nothing', async () => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), { query: `&digest=${sha256('other')}` });
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.body).error).toContain(sha256('other'));
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await tempsOnDisk()).toEqual([]);
    expect(await readdir(runsDir()).catch(() => [])).toEqual([]);
  });

  it.each([
    ['another repository', { ...SCOPE, repositoryId: '8' }],
    ['another run', { ...SCOPE, runId: '101' }],
    ['another attempt of the run', { ...SCOPE, runAttempt: '2' }],
  ])('keeps a name apart in %s', async (_, scope) => {
    await startServer();
    const first = randomBytes(8);
    const one = stored(await put('a.apk', first));

    verification = { ...VERIFIED, scope };
    const content = randomBytes(8);
    const answer = await put('a.apk', content);

    expect(answer.status).toBe(201);
    const other = stored(answer);
    expect(other.id).not.toBe(one.id);
    expect((await send('GET', one.pathname)).bytes.equals(first)).toBe(true);
    expect((await send('GET', other.pathname)).bytes.equals(content)).toBe(true);

    // Overwriting there leaves the first scope's artifact where it is.
    expect((await put('a.apk', randomBytes(8), '&overwrite=true')).status).toBe(201);
    expect((await send('GET', one.pathname)).bytes.equals(first)).toBe(true);
  });

  it('follows the repository by its ID through a rename', async () => {
    await startServer();
    await put('a.apk', randomBytes(8));
    verification = { ...VERIFIED, repository: 'fishballapp/renamed' };
    expect((await put('a.apk', randomBytes(8))).status).toBe(409);
  });

  it('takes the same name with other case as another name, on any disk', async () => {
    await startServer();
    const lower = randomBytes(8);
    const upper = randomBytes(8);
    const one = stored(await put('a.apk', lower));
    const other = stored(await put('A.apk', upper));
    expect((await send('GET', one.pathname)).bytes.equals(lower)).toBe(true);
    expect((await send('GET', other.pathname)).bytes.equals(upper)).toBe(true);
  });

  it('takes a name again once what it referred to has expired', async () => {
    await startServer();
    await put('a.apk', randomBytes(8), '&retention-days=1');
    now = NOW.add({ hours: 24 });
    const answer = await put('a.apk', randomBytes(8));
    expect(answer.status).toBe(201);
    expect((await send('GET', stored(answer).pathname)).status).toBe(200);
    expect(await artifactsOnDisk()).toEqual([stored(answer).id]);
  });

  it('holds a 255-character name, with room for the file that names it', async () => {
    await startServer();
    await put('a'.repeat(255), randomBytes(8));
    expect(await namesOnDisk()).toHaveLength(1);
  });
});

describe('uploads racing for one name', () => {
  /**
   * Every request is past the first check, its temp open, before any of them may finish, so
   * the only thing left to decide between them is the publish.
   */
  const race = async (contents: Uint8Array[], query = '') => {
    const requests = contents.map(content => {
      const req = openRequest('POST', `/artifacts?name=a.apk&digest=${sha256(content)}${query}`, {
        ...AUTH,
        'Content-Length': content.length,
      });
      req.write(content.subarray(0, 1));
      return {
        content,
        req,
        answer: new Promise<Answer>((resolve, reject) => {
          req.on('response', res => resolve(answerOf(res)));
          req.on('error', reject);
        }),
      };
    });
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(contents.length));
    for (const { req, content } of requests) req.end(content.subarray(1));
    return Promise.all(
      requests.map(async ({ answer, content }) => ({ answer: await answer, content })),
    );
  };

  it('lets exactly one win, leaving nothing of the others', async () => {
    await startServer();
    const answers = await race(Array.from({ length: 16 }, () => randomBytes(64 * 1024)));

    const winners = answers.filter(({ answer }) => answer.status === 201);
    const losers = answers.filter(({ answer }) => answer.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(15);
    const [winner] = winners;
    if (winner === undefined) throw new Error('no winner');
    const { id, pathname } = stored(winner.answer);
    expect((await send('GET', pathname)).bytes.equals(winner.content)).toBe(true);
    expect(await artifactsOnDisk()).toEqual([id]);
    expect(await namesOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('with overwrite, leaves only the last one, with no sweep needed', async () => {
    await startServer();
    const answers = await race(
      Array.from({ length: 16 }, () => randomBytes(64 * 1024)),
      '&overwrite=true',
    );

    expect(answers.map(({ answer }) => answer.status)).toEqual(Array(16).fill(201));
    expect(await artifactsOnDisk()).toHaveLength(1);
    expect(await namesOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
    const reads = await Promise.all(
      answers.map(({ answer }) => send('GET', stored(answer).pathname)),
    );
    expect(reads.map(({ status }) => status).toSorted()).toEqual([200, ...Array(15).fill(404)]);
  });

  it('gives uploads of the same content the same artifact', async () => {
    await startServer();
    const content = randomBytes(64 * 1024);
    const answers = await race([content, content, content, content]);

    expect(answers.map(({ answer }) => answer.status).toSorted()).toEqual([200, 200, 200, 201]);
    expect(new Set(answers.map(({ answer }) => stored(answer).id)).size).toBe(1);
    expect(await artifactsOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('finishes publishing for a client that has gone', async () => {
    await startServer();
    const content = randomBytes(64 * 1024);
    const req = openRequest('POST', `/artifacts?name=a.apk&digest=${sha256(content)}`, {
      ...AUTH,
      'Content-Length': content.length,
    });
    req.on('error', () => undefined);
    req.end(content, () => req.destroy());
    await vi.waitFor(async () => {
      expect(await tempsOnDisk()).toEqual([]);
    });

    // However far it got, the retry finds the name free or holding this very content.
    const retry = await upload('a.apk', content, { query: `&digest=${sha256(content)}` });
    expect([200, 201]).toContain(retry.status);
    expect((await send('GET', stored(retry).pathname)).bytes.equals(content)).toBe(true);
    expect(await artifactsOnDisk()).toHaveLength(1);
  });
});

describe('the sweep', () => {
  const makeOldTemp = async (entry: string) => {
    await mkdir(join(storeDir, 'tmp'), { recursive: true });
    await writeFile(join(storeDir, 'tmp', entry), 'partial');
    const modifiedAt = new Date(
      Temporal.Now.instant().subtract({ minutes: Duration.toMinutes(UPLOAD_TIMEOUT) + 2 })
        .epochMilliseconds,
    );
    await utimes(join(storeDir, 'tmp', entry), modifiedAt, modifiedAt);
  };

  it('removes an expired artifact, its name and the directories that leaves empty', async () => {
    await startServer();
    await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    now = NOW.add({ hours: 24 });

    expect(await sweep()).toEqual({ removedNames: 1, removedArtifacts: 1, removedTemps: 0 });

    expect(await artifactsOnDisk()).toEqual([]);
    expect(await readdir(runsDir())).toEqual([]);
  });

  it('keeps a live name, and the directories above it, beside an expired one', async () => {
    await startServer();
    await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    const kept = await uploaded('b.apk', randomBytes(8), '&retention-days=2');
    now = NOW.add({ hours: 24 });

    expect(await sweep()).toEqual({ removedNames: 1, removedArtifacts: 1, removedTemps: 0 });

    expect(await artifactsOnDisk()).toEqual([kept.token]);
    expect(await namesOnDisk()).toEqual([`${sha256('b.apk')}.json`]);
    expect((await send('GET', kept.pathname)).status).toBe(200);
  });

  it('removes what a crash left before the name was written', async () => {
    await startServer();
    const { pathname } = await uploaded('a.apk', randomBytes(8));
    await rm(nameFile('a.apk'));

    expect((await send('GET', pathname)).status).toBe(404);
    expect(await sweep()).toMatchObject({ removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await readdir(runsDir())).toEqual([]);
    await uploaded('a.apk', randomBytes(8));
  });

  it('removes what a crash left mid-replacement, and the old link has already stopped', async () => {
    await startServer();
    const old = await uploaded('a.apk', randomBytes(8));
    const copy = join(rootDir, 'kept-artifact');
    await cp(join(storeDir, 'artifacts', old.token), copy, { recursive: true });
    const replacement = await upload('a.apk', randomBytes(8), { query: '&overwrite=true' });
    await cp(copy, join(storeDir, 'artifacts', old.token), { recursive: true });

    expect((await send('GET', old.pathname)).status).toBe(404);
    expect(await sweep()).toMatchObject({ removedNames: 0, removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([stored(replacement).id]);
    expect((await send('GET', stored(replacement).pathname)).status).toBe(200);
  });

  it('removes what a crash left as a replacement name not yet moved into place', async () => {
    await startServer();
    now = Temporal.Now.instant();
    await makeOldTemp(`${'a'.repeat(43)}.name`);
    expect(await sweep()).toMatchObject({ removedTemps: 1 });
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('recovers from a publish that fails after its directory has moved', async () => {
    await startServer();
    // In the way of the name, so publishing fails at its last step.
    await mkdir(nameFile('a.apk'), { recursive: true });

    expect((await upload('a.apk', randomBytes(8))).status).toBe(500);
    expect(await artifactsOnDisk()).toHaveLength(1);
    expect(await tempsOnDisk()).toEqual([]);

    expect(await sweep()).toMatchObject({ removedNames: 1, removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([]);
    await uploaded('a.apk', randomBytes(8));
  });

  it('removes a name whose artifact is gone, so the name can be taken again', async () => {
    await startServer();
    const { token } = await uploaded('a.apk', randomBytes(8));
    await rm(join(storeDir, 'artifacts', token), { recursive: true });

    expect(await sweep()).toMatchObject({ removedNames: 1, removedArtifacts: 0 });
    expect(await readdir(runsDir())).toEqual([]);
    await uploaded('a.apk', randomBytes(8));
  });

  it('removes what no name can be read from, and anything else in the way', async () => {
    await startServer();
    await mkdir(namesDir(), { recursive: true });
    await writeFile(join(namesDir(), 'bad.json'), '{"name":3}');
    await writeFile(join(namesDir(), '.DS_Store'), 'junk');
    await writeFile(join(runsDir(), SCOPE.repositoryId, '.DS_Store'), 'junk');
    await writeFile(join(runsDir(), '.DS_Store'), 'junk');

    expect(await sweep()).toMatchObject({ removedNames: 2 });
    expect(await readdir(runsDir())).toEqual([]);
  });

  it('removes a stored file of the old format: no second way to read one', async () => {
    await startServer();
    const token = 'b'.repeat(43);
    await mkdir(join(storeDir, 'artifacts', token), { recursive: true });
    await writeFile(join(storeDir, 'artifacts', token, 'data'), 'old');
    await writeFile(
      join(storeDir, 'artifacts', token, 'meta.json'),
      JSON.stringify({ name: 'old.apk', size: 3, expiresAt: '2030-01-01T00:00:00Z' }),
    );

    expect((await send('GET', `/${token}/old.apk`)).status).toBe(404);
    expect(await sweep()).toMatchObject({ removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it('never removes an upload mid-publish', async () => {
    await startServer();
    const answers = await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const [answer] = await Promise.all([uploaded(`${index}.apk`, randomBytes(8)), sweep()]);
        return answer;
      }),
    );
    await sweep();
    const reads = await Promise.all(answers.map(({ pathname }) => send('GET', pathname)));
    expect(reads.map(({ status }) => status)).toEqual(Array(32).fill(200));
    expect(await artifactsOnDisk()).toHaveLength(32);
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
    const content = randomBytes(8);
    const { pathname, token } = await uploaded(name, content);
    await send('GET', pathname);
    await send('HEAD', pathname);
    await send('GET', `/${token}/wrong.apk`);
    await upload(name, content, { query: `&digest=${sha256(content)}` });
    await upload(name, content);
    await upload(name, randomBytes(8), { query: `&digest=${sha256('other')}` });
    verification = { kind: 'rejected', reason: 'wrong org' };
    await upload(name, randomBytes(8));
    // A failing upload: the store's own directory is in the way, so the error names a path.
    verification = VERIFIED;
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

  it('say why an upload stopped when writing it fails', async () => {
    const failToWrite = () =>
      Effect.fail(
        PlatformError.systemError({
          _tag: 'Unknown',
          module: 'FileSystem',
          method: 'sink',
          description: 'disk full',
        }),
      );
    await startServer(
      { maxFileBytes: 4 * 1024 ** 2 },
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, fs =>
          FileSystem.FileSystem.of({
            ...fs,
            sink: () => Sink.forEach(failToWrite),
          }),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    );
    await upload('a.apk', randomBytes(2 * 1024 ** 2)).catch(() => undefined);
    await vi.waitFor(() => expect(logLines.join('\n')).toMatch(/upload stopped.*name=a\.apk/u));
  });

  it('name the upload a fast refusal or a recovered retry belongs to', async () => {
    await startServer();
    const content = randomBytes(8);
    await uploaded('a.apk', content);
    await upload('a.apk', content, { query: `&digest=${sha256(content)}` });
    await upload('a.apk', randomBytes(8), { query: `&digest=${sha256('other')}` });
    const logged = logLines.join('\n');
    expect(logged).toMatch(/upload already stored.*digest=.*expiresAt=/u);
    const refused = logLines.find(line => line.includes('upload refused'));
    expect(refused).toContain('name taken');
    expect(refused).toContain('repository=fishballapp/private-thing');
    expect(refused).toContain('name=a.apk');
  });

  it('do not echo a refused name', async () => {
    await startServer();
    await upload('evil%0Aforged-log-line', randomBytes(8));
    expect(logLines.join('\n')).not.toContain('forged-log-line');
  });
});
