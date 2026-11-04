import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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

const freeSpace = vi.hoisted(() => ({ bytes: undefined as number | undefined }));

// What a disk has free can't be arranged, so a test that needs a number says it here.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: async (path: string) =>
      freeSpace.bytes === undefined ? actual.statfs(path) : { bavail: freeSpace.bytes, bsize: 1 },
  };
});

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

const diskStore = (dir: string, minFreeBytes = 0) => ({ kind: 'disk', dir, minFreeBytes }) as const;

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

const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

type UploadOptions = { query?: string; headers?: OutgoingHttpHeaders; digest?: string };

const declarationOf = (
  name: string,
  content: Uint8Array,
  { query = '', digest = sha256(content) }: UploadOptions = {},
) => `name=${name}&digest=${digest}&size=${content.length}${query}`;

const create = (name: string, content: Uint8Array, options: UploadOptions = {}) =>
  send('POST', `/uploads?${declarationOf(name, content, options)}`, {
    headers: options.headers ?? AUTH,
  });

const targetOf = ({ body }: Answer) =>
  (JSON.parse(body) as { upload: { id: string; url: string; headers: Record<string, string> } })
    .upload;

const created = async (name: string, content: Uint8Array, options: UploadOptions = {}) => {
  const answer = await create(name, content, options);
  expect(answer.status).toBe(201);
  return targetOf(answer);
};

const commit = (id: string, name: string, content: Uint8Array, options: UploadOptions = {}) =>
  send('POST', `/uploads/${id}/commit?${declarationOf(name, content, options)}`, {
    headers: options.headers ?? AUTH,
  });

/** All three steps, as a client takes them, stopping at the first that refuses. */
const upload = async (name: string, content: Uint8Array, options: UploadOptions = {}) => {
  const answer = await create(name, content, options);
  if (answer.status !== 201) return answer;
  const { id, url } = targetOf(answer);
  const sent = await send('PUT', url, { body: content });
  if (sent.status !== 200) return sent;
  return commit(id, name, content, options);
};

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

const uploadedAt = (id: string) => join(storeDir, 'tmp', id);
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
  freeSpace.bytes = undefined;
  baseConfig = {
    store: diskStore(storeDir),
    oidcAudience: 'self-hosted-artifacts',
    oidcRepositoryOwnerId: '42',
    linkBases: { home: 'http://192.0.2.1:8420', tailscale: 'https://files.example' },
    host: '127.0.0.1',
    port: 0,
    defaultRetentionDays: 7,
    maxRetentionDays: 30,
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
    expect((await send('PATCH', '/artifacts?name=x')).status).toBe(404);
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
    const answer = await send('POST', '/uploads', { headers: AUTH });
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
      const answer = await create('a.apk', randomBytes(8), { digest });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body).error).toMatch(/^digest must be/);
      expect(await tempsOnDisk()).toEqual([]);
    },
  );

  it('refuses no digest', async () => {
    await startServer();
    const answer = await send('POST', '/uploads?name=a.apk&size=8', { headers: AUTH });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toMatch(/^digest must be/);
  });

  it.each(['size=-1&', 'size=1.5&', 'size=8e3&', 'size=&', 'size=soon&', ''])(
    'refuses a size in `%s`',
    async size => {
      await startServer();
      const answer = await send('POST', `/uploads?${size}name=a.apk&digest=${sha256('a')}`, {
        headers: AUTH,
      });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body).error).toMatch(/^size must be/);
      expect(await tempsOnDisk()).toEqual([]);
    },
  );

  it.each(['yes', 'TRUE', '1', ''])('refuses overwrite=%s', async overwrite => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), { query: `&overwrite=${overwrite}` });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toMatch(/^overwrite must be/);
  });

  it('answers 413 from the size declared', async () => {
    await startServer({ maxFileBytes: 10 });
    expect((await upload('a.apk', randomBytes(11))).status).toBe(413);
    expect(await tempsOnDisk()).toEqual([]);
    await uploaded('a.apk', randomBytes(10));
    const huge = await send(
      'POST',
      `/uploads?name=b.apk&digest=${sha256('a')}&size=${'9'.repeat(400)}`,
      {
        headers: AUTH,
      },
    );
    expect(huge.status).toBe(413);
  });

  it('answers 507 when the upload would cross the free-space floor', async () => {
    await startServer({ store: diskStore(storeDir, Number.MAX_SAFE_INTEGER) });
    const answer = await upload('a.apk', randomBytes(8));
    expect(answer.status).toBe(507);
    expect(await tempsOnDisk()).toEqual([]);
  });

  it('counts the file against the free-space floor', async () => {
    await startServer({ store: diskStore(storeDir, 900) });
    freeSpace.bytes = 1000;
    expect((await upload('a.apk', randomBytes(100))).status).toBe(201);
    expect((await upload('b.apk', randomBytes(101))).status).toBe(507);
  });

  it('checks the floor again as a body starts, as URLs made earlier could otherwise pass it together', async () => {
    await startServer({ store: diskStore(storeDir, 900) });
    freeSpace.bytes = 1000;
    const content = randomBytes(100);
    const { id, url } = targetOf(await create('a.apk', content));
    freeSpace.bytes = 999;
    expect((await send('PUT', url, { body: content })).status).toBe(507);
    freeSpace.bytes = 1000;
    expect((await send('PUT', url, { body: content })).status).toBe(200);
    expect((await commit(id, 'a.apk', content)).status).toBe(201);
  });
});

describe('an upload, step by step', () => {
  const content = randomBytes(64);

  /** A token for what the test says, as `verification` is, from the next request on. */
  const asRun = (scope: Partial<typeof SCOPE>) => {
    verification = { ...VERIFIED, scope: { ...SCOPE, ...scope } };
  };

  const sentBody = async (name = 'a.apk') => {
    const target = await created(name, content);
    expect((await send('PUT', target.url, { body: content })).status).toBe(200);
    return target;
  };

  describe('starting', () => {
    it('answers with a path on this server and what to send, and takes no body', async () => {
      await startServer();
      const answer = await create('a.apk', content);

      expect(answer.status).toBe(201);
      const { id, url, headers } = targetOf(answer);
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url).toBe(`/uploads/${id}`);
      expect(headers).toEqual({ 'content-type': 'application/octet-stream' });
      expect(await artifactsOnDisk()).toEqual([]);
    });

    it('keeps what was declared beside where the body will go', async () => {
      await startServer();
      const { id } = await created('a.apk', content, { query: '&retention-days=3&overwrite=true' });
      expect(await readdir(uploadedAt(id))).toEqual(['upload.json']);
      expect(JSON.parse(await readFile(join(uploadedAt(id), 'upload.json'), 'utf8'))).toEqual({
        id,
        ...SCOPE,
        name: 'a.apk',
        size: content.length,
        digest: sha256(content),
        overwrite: true,
        retentionDays: 3,
        createdAtMs: NOW.epochMilliseconds,
      });
    });

    it('no longer takes a body at `POST /artifacts`', async () => {
      await startServer();
      const answer = await send('POST', `/artifacts?name=a.apk&digest=${sha256(content)}`, {
        headers: AUTH,
        body: content,
      });
      expect(answer.status).toBe(404);
      expect(await tempsOnDisk()).toEqual([]);
    });
  });

  describe('sending the body', () => {
    it('needs no token: the URL is the capability', async () => {
      await startServer();
      const { url } = await created('a.apk', content);
      verification = { kind: 'rejected', reason: 'nobody' };
      expect((await send('PUT', url, { body: content })).status).toBe(200);
    });

    it.each([
      ['an unknown ID', `/uploads/${'a'.repeat(43)}`],
      ['an ID of the wrong shape', '/uploads/short'],
      ['a traversal', '/uploads/..%2f..%2fetc'],
      ['a query string', '/uploads/<id>?x=1'],
    ])('answers 404 for %s, leaving nothing', async (_, path) => {
      await startServer();
      const { id } = await created('a.apk', content);
      const answer = await send('PUT', path.replace('<id>', id), { body: content });
      expect(answer.status).toBe(404);
      expect(await tempsOnDisk()).toEqual([id]);
      expect(await readdir(uploadedAt(id))).toEqual(['upload.json']);
    });

    it('answers 404 once the hour is up, before any of the body', async () => {
      await startServer();
      const { url } = await created('a.apk', content);
      now = NOW.add({ minutes: Duration.toMinutes(UPLOAD_TIMEOUT) - 1 });
      const inTime = await send('PUT', url, { body: content });
      expect(inTime.status).toBe(200);
      now = NOW.add({ minutes: Duration.toMinutes(UPLOAD_TIMEOUT) });
      expect((await send('PUT', url, { body: content })).status).toBe(404);
    });

    it.each([
      ['too small', 63],
      ['too big', 65],
    ])('answers 400 for a Content-Length %s, before any of the body', async (_, length) => {
      await startServer();
      const { id, url } = await created('a.apk', content);
      // The headers promise a body that never comes: only an answer that ignores it can arrive.
      const answer = await new Promise<Answer>((resolve, reject) => {
        const req = openRequest('PUT', url, { 'Content-Length': length });
        req.on('response', res => resolve(answerOf(res)));
        req.on('error', reject);
        req.flushHeaders();
      });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body).error).toContain(String(content.length));
      expect(await tempsOnDisk()).toEqual([id]);
      expect((await send('PUT', url, { body: content })).status).toBe(200);
    });

    it('answers 400 for no Content-Length', async () => {
      await startServer();
      const { url } = await created('a.apk', content);
      const answer = await new Promise<Answer>((resolve, reject) => {
        const req = openRequest('PUT', url, { 'Transfer-Encoding': 'chunked' });
        req.on('response', res => resolve(answerOf(res)));
        req.on('error', reject);
        req.end(content);
      });
      expect(answer.status).toBe(400);
    });

    it('answers 422 for the wrong digest, leaving nothing behind', async () => {
      await startServer();
      const { id, url } = await created('a.apk', content);

      const answer = await send('PUT', url, { body: randomBytes(content.length) });

      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.body).error).toMatch(
        /^The body's SHA-256 is [0-9a-f]{64}, not the digest sent, [0-9a-f]{64}\. Did the file change while it was uploading\?$/,
      );
      expect(await tempsOnDisk()).toEqual([]);
      expect(await artifactsOnDisk()).toEqual([]);
      expect((await send('PUT', url, { body: content })).status).toBe(404);
      expect((await commit(id, 'a.apk', content)).status).toBe(404);
    });

    it('takes another try, which replaces the first', async () => {
      await startServer();
      const { id, url } = await sentBody();
      expect((await send('PUT', url, { body: content })).status).toBe(200);
      expect((await readdir(uploadedAt(id))).toSorted()).toEqual(['data', 'upload.json']);
      expect(await tempsOnDisk()).toEqual([id]);

      const answer = await commit(id, 'a.apk', content);
      expect(answer.status).toBe(201);
      expect((await send('GET', stored(answer).pathname)).bytes.equals(content)).toBe(true);
    });

    it('answers 404 after the commit, leaving the artifact as it was', async () => {
      await startServer();
      const { id, url } = await sentBody();
      const { pathname } = stored(await commit(id, 'a.apk', content));

      expect((await send('PUT', url, { body: randomBytes(content.length) })).status).toBe(404);
      expect((await send('PUT', url, { body: content })).status).toBe(404);

      expect((await send('GET', pathname)).bytes.equals(content)).toBe(true);
      expect(await artifactsOnDisk()).toEqual([id]);
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('answers 404 to a try still arriving when the commit lands, leaving nothing of it', async () => {
      await startServer();
      const { id, url } = await sentBody();
      const late = new Promise<Answer>((resolve, reject) => {
        const req = openRequest('PUT', url, { 'Content-Length': content.length });
        req.on('response', res => resolve(answerOf(res)));
        req.on('error', reject);
        req.write(content.subarray(0, 8), () => {
          void vi
            .waitFor(async () => expect(await tempsOnDisk()).toHaveLength(2))
            .then(async () => {
              expect((await commit(id, 'a.apk', content)).status).toBe(201);
              req.end(content.subarray(8));
            });
        });
      });

      expect((await late).status).toBe(404);
      expect(await tempsOnDisk()).toEqual([]);
      expect((await readdir(join(storeDir, 'artifacts', id))).toSorted()).toEqual([
        'data',
        'meta.json',
      ]);
    });
  });

  describe('committing', () => {
    it("makes the upload's ID the artifact's, with a token of its own", async () => {
      await startServer();
      const { id } = await sentBody();
      const answer = await commit(id, 'a.apk', content);
      expect(answer.status).toBe(201);
      expect(stored(answer).id).toBe(id);
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('answers 404 for an upload whose body never came, which can still come', async () => {
      await startServer();
      const { id, url } = await created('a.apk', content);

      const answer = await commit(id, 'a.apk', content);

      expect(answer.status).toBe(404);
      expect(JSON.parse(answer.body).error).toMatch(/^This upload is not there to commit/);
      await send('PUT', url, { body: content });
      expect((await commit(id, 'a.apk', content)).status).toBe(201);
    });

    it('answers 404 for an unknown ID', async () => {
      await startServer();
      expect((await commit('a'.repeat(43), 'a.apk', content)).status).toBe(404);
    });

    it.each([
      ['another repository', { repositoryId: '8' }],
      ['another run', { runId: '101' }],
      ['another attempt', { runAttempt: '2' }],
    ])('answers 404 to a token of %s, and the upload is still there', async (_, scope) => {
      await startServer();
      const { id } = await sentBody();

      asRun(scope);
      expect((await commit(id, 'a.apk', content)).status).toBe(404);
      expect(await tempsOnDisk()).toEqual([id]);

      asRun({});
      expect((await commit(id, 'a.apk', content)).status).toBe(201);

      asRun(scope);
      expect((await commit(id, 'a.apk', content)).status).toBe(404);
    });

    it.each([
      ['a name', { name: 'b.apk', content, options: {} }],
      ['a digest', { name: 'a.apk', content, options: { digest: sha256('other') } }],
      ['a size', { name: 'a.apk', content: randomBytes(65), options: { digest: sha256(content) } }],
      ['retention', { name: 'a.apk', content, options: { query: '&retention-days=1' } }],
      ['overwrite', { name: 'a.apk', content, options: { query: '&overwrite=true' } }],
    ])('answers 404 when it declares another %s', async (_, declared) => {
      await startServer();
      const { id } = await sentBody();
      expect((await commit(id, declared.name, declared.content, declared.options)).status).toBe(
        404,
      );
      expect((await commit(id, 'a.apk', content)).status).toBe(201);
    });

    it('checks the token and what it declares before anything else', async () => {
      await startServer();
      const { id } = await sentBody();
      expect((await commit(id, 'a.apk', content, { headers: {} })).status).toBe(401);
      expect((await commit(id, '.bad', content)).status).toBe(400);
      expect(await tempsOnDisk()).toEqual([id]);
    });

    it('answers a commit of what is already committed with the same artifact', async () => {
      await startServer();
      const { id } = await sentBody();
      const first = await commit(id, 'a.apk', content);

      const again = await commit(id, 'a.apk', content);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
      expect(await artifactsOnDisk()).toEqual([id]);
    });

    it('answers commits that cross with the one artifact', async () => {
      await startServer();
      const { id } = await sentBody();
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => commit(id, 'a.apk', content)),
      );
      expect(answers.map(({ status }) => status).toSorted()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(await artifactsOnDisk()).toEqual([id]);
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('answers 409 if the name was taken meanwhile, leaving nothing of it', async () => {
      await startServer();
      const { id } = await sentBody();
      const other = randomBytes(64);
      const winner = stored(await upload('a.apk', other));

      const answer = await commit(id, 'a.apk', content);

      expect(answer.status).toBe(409);
      expect(JSON.parse(answer.body).error).toMatch(/already exists on the workflow run/);
      expect(await tempsOnDisk()).toEqual([]);
      expect((await send('GET', winner.pathname)).bytes.equals(other)).toBe(true);
    });

    it('replaces what took the name meanwhile, with overwrite', async () => {
      await startServer();
      const { id, url } = await created('a.apk', content, { query: '&overwrite=true' });
      await send('PUT', url, { body: content });
      const old = stored(await upload('a.apk', randomBytes(64)));

      const answer = await commit(id, 'a.apk', content, { query: '&overwrite=true' });

      expect(answer.status).toBe(201);
      expect((await send('GET', old.pathname)).status).toBe(404);
      expect(await artifactsOnDisk()).toEqual([id]);
    });

    it('answers with what took the name meanwhile if it is the same content', async () => {
      await startServer();
      const { id } = await sentBody();
      const winner = stored(await upload('a.apk', content));

      const answer = await commit(id, 'a.apk', content);

      expect(answer.status).toBe(200);
      expect(stored(answer).id).toBe(winner.id);
      expect(await artifactsOnDisk()).toEqual([winner.id]);
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('still takes a body that took most of the hour, after the hour is up', async () => {
      await startServer();
      const { id } = await sentBody();
      now = NOW.add({ minutes: Duration.toMinutes(UPLOAD_TIMEOUT) + 1 });
      expect((await commit(id, 'a.apk', content)).status).toBe(201);
    });

    it('answers 503 while the store is missing', async () => {
      await startServer();
      const { id } = await sentBody();
      await rm(storeDir, { recursive: true });
      expect((await commit(id, 'a.apk', content)).status).toBe(503);
    });
  });

  describe('abandoned', () => {
    const age = async (entry: string) => {
      const modifiedAt = new Date(
        Temporal.Now.instant().subtract({ minutes: Duration.toMinutes(UPLOAD_TIMEOUT) + 2 })
          .epochMilliseconds,
      );
      await utimes(join(storeDir, 'tmp', entry), modifiedAt, modifiedAt);
    };

    it.each([
      ['with no body', false],
      ['with its body', true],
    ])('is swept %s, and can no longer be committed', async (_, hasBody) => {
      await startServer();
      now = Temporal.Now.instant();
      const { id, url } = await created('a.apk', content);
      if (hasBody) await send('PUT', url, { body: content });
      const fresh = await created('b.apk', content);
      await age(id);

      expect(await sweep()).toMatchObject({ removedTemps: 1, removedArtifacts: 0 });

      expect(await tempsOnDisk()).toEqual([fresh.id]);
      expect((await commit(id, 'a.apk', content)).status).toBe(404);
      expect((await send('PUT', url, { body: content })).status).toBe(404);
    });

    it('is swept with a body a crash left on its way', async () => {
      await startServer();
      now = Temporal.Now.instant();
      const { id } = await created('a.apk', content);
      await writeFile(join(storeDir, 'tmp', `${id}.part`), 'partial');
      await age(id);
      await age(`${id}.part`);

      expect(await sweep()).toMatchObject({ removedTemps: 2 });
      expect(await tempsOnDisk()).toEqual([]);
    });
  });
});

describe('listing a run', () => {
  const HOSTILE = { repository: 'fishballapp/other', repositoryId: '8' };
  const verifiedAs = (scope: Partial<typeof SCOPE>, repository: string = VERIFIED.repository) => {
    verification = { kind: 'verified', repository, scope: { ...SCOPE, ...scope } };
  };
  const list = async (query = '') => {
    const answer = await send('GET', `/artifacts${query}`, { headers: AUTH });
    expect(answer.status).toBe(200);
    return (
      JSON.parse(answer.body) as { artifacts: { id: string; name: string; runAttempt: string }[] }
    ).artifacts;
  };
  const namesOf = (artifacts: { name: string }[]) => artifacts.map(({ name }) => name);

  it('answers with each artifact of the token’s run, in name order, with its scope and links', async () => {
    await startServer();
    const content = randomBytes(8);
    const b = await uploaded('b.apk', content);
    await uploaded('a.apk', randomBytes(8));
    verifiedAs({ runId: '200' });
    await uploaded('elsewhere.apk', randomBytes(8));
    verifiedAs({});

    const artifacts = await list();

    expect(namesOf(artifacts)).toEqual(['a.apk', 'b.apk']);
    expect(artifacts[1]).toEqual({
      id: b.id,
      name: 'b.apk',
      size: content.length,
      digest: sha256(content),
      expiresAt: '2026-06-08T12:00:00Z',
      links: {
        home: `http://192.0.2.1:8420/${b.id}/b.apk`,
        tailscale: `https://files.example/${b.id}/b.apk`,
      },
      repositoryId: '7',
      runId: '100',
      runAttempt: '1',
    });
  });

  it('takes the latest attempt that holds a name, comparing attempts as numbers', async () => {
    await startServer();
    verifiedAs({ runAttempt: '9' });
    await uploaded('both.apk', randomBytes(8));
    await uploaded('old-only.apk', randomBytes(8));
    verifiedAs({ runAttempt: '10' });
    const latest = await uploaded('both.apk', randomBytes(8));

    const artifacts = await list();

    expect(namesOf(artifacts)).toEqual(['both.apk', 'old-only.apk']);
    expect(artifacts[0]).toMatchObject({ id: latest.id, runAttempt: '10' });
    expect(artifacts[1]).toMatchObject({ runAttempt: '9' });
    expect(await list('?name=both.apk')).toMatchObject([{ id: latest.id, runAttempt: '10' }]);
    expect(await list('?name=old-only.apk')).toMatchObject([{ runAttempt: '9' }]);
  });

  it('falls back to an earlier attempt once the latest has expired, as the sweep will', async () => {
    await startServer();
    const kept = await uploaded('a.apk', randomBytes(8), '&retention-days=5');
    verifiedAs({ runAttempt: '2' });
    await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    now = NOW.add({ hours: 24 });
    expect(await list()).toMatchObject([{ id: kept.id, runAttempt: '1' }]);
    expect(await list('?name=a.apk')).toMatchObject([{ id: kept.id, runAttempt: '1' }]);
  });

  it('leaves out what has expired, and answers an empty run with nothing', async () => {
    await startServer();
    await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    now = NOW.add({ hours: 24 });
    expect(await list()).toEqual([]);
    expect(await list('?name=a.apk')).toEqual([]);
    expect(await list('?run-id=999')).toEqual([]);
  });

  it('narrows to names, taking any string as one that is simply not there', async () => {
    await startServer();
    await uploaded('a.zip', randomBytes(8));
    await uploaded('b.apk', randomBytes(8));
    expect(namesOf(await list('?name=a.zip&name=a'))).toEqual(['a.zip']);
    expect(await list(`?name=${encodeURIComponent('../../etc/passwd')}`)).toEqual([]);
    expect(await list(`?name=${'x'.repeat(10_000)}`)).toEqual([]);
  });

  describe('by ID', () => {
    it('answers only with what belongs to the repository and run asked about', async () => {
      await startServer();
      const here = await uploaded('a.apk', randomBytes(8));
      verifiedAs({ runId: '200' });
      const otherRun = await uploaded('b.apk', randomBytes(8));
      verifiedAs({ repositoryId: HOSTILE.repositoryId, runId: '100' }, HOSTILE.repository);
      const otherRepository = await uploaded('c.apk', randomBytes(8));
      verifiedAs({});

      const query = `?id=${here.id}&id=${otherRun.id}&id=${otherRepository.id}`;
      expect((await list(query)).map(({ id }) => id)).toEqual([here.id]);
      expect((await list(`${query}&run-id=200`)).map(({ id }) => id)).toEqual([otherRun.id]);
      expect((await list(`${query}&repository=${HOSTILE.repository}`)).map(({ id }) => id)).toEqual(
        [otherRepository.id],
      );
    });

    it("leaves out an earlier attempt's artifact once a later one holds its name", async () => {
      await startServer();
      const first = await uploaded('a.apk', randomBytes(8));
      verifiedAs({ runAttempt: '2' });
      const second = await uploaded('a.apk', randomBytes(8));
      expect((await list(`?id=${first.id}`)).map(({ id }) => id)).toEqual([]);
      expect((await list(`?id=${second.id}`)).map(({ id }) => id)).toEqual([second.id]);
    });

    it.each([
      ['the wrong shape', '?id=short'],
      ['a traversal', `?id=${encodeURIComponent('../../etc/passwd')}`],
      ['one bad among good', `?id=${'a'.repeat(43)}&id=short`],
      ['a name beside it', `?id=${'a'.repeat(43)}&name=a.apk`],
    ])('refuses %s with a 400', async (_, query) => {
      await startServer();
      expect((await send('GET', `/artifacts${query}`, { headers: AUTH })).status).toBe(400);
    });
  });

  describe('another repository of the owner', () => {
    const uploadIn = async (repository: string, repositoryId: string, name: string) => {
      verifiedAs({ repositoryId, runId: '200' }, repository);
      const answer = await uploaded(name, randomBytes(8));
      verifiedAs({});
      return answer;
    };

    it('reads it by name and run, whatever the case', async () => {
      await startServer();
      const theirs = await uploadIn('fishballapp/Other', '8', 'theirs.apk');
      expect((await list('?repository=fishballapp/other&run-id=200')).map(({ id }) => id)).toEqual([
        theirs.id,
      ]);
      expect((await list('?repository=FISHBALLAPP/OTHER&run-id=200')).map(({ id }) => id)).toEqual([
        theirs.id,
      ]);
    });

    it("takes the token's run when only the repository is named, as upstream's rule has it", async () => {
      await startServer();
      await uploadIn('fishballapp/other', '8', 'theirs.apk');
      expect(await list('?repository=fishballapp/other')).toEqual([]);
    });

    it('needs no record for the token’s own repository', async () => {
      await startServer();
      const own = await uploaded('a.apk', randomBytes(8));
      await rm(join(storeDir, 'repositories'), { recursive: true });
      expect((await list(`?repository=${VERIFIED.repository}`)).map(({ id }) => id)).toEqual([
        own.id,
      ]);
    });

    it('answers nothing for a repository that has never uploaded', async () => {
      await startServer();
      await uploaded('a.apk', randomBytes(8));
      expect(await list('?repository=fishballapp/nobody')).toEqual([]);
    });

    it('follows a rename at the next upload, keeping the old name until nothing uses it', async () => {
      await startServer();
      const before = await uploadIn('fishballapp/old', '8', 'a.apk');
      const after = await uploadIn('fishballapp/new', '8', 'b.apk');
      const ids = [before.id, after.id].toSorted();
      for (const repository of ['fishballapp/old', 'fishballapp/new']) {
        const found = await list(`?repository=${repository}&run-id=200`);
        expect(found.map(({ id }) => id).toSorted()).toEqual(ids);
      }
    });

    it('points a name at whichever repository uploaded under it last', async () => {
      await startServer();
      await uploadIn('fishballapp/taken', '8', 'first.apk');
      const second = await uploadIn('fishballapp/taken', '9', 'second.apk');
      expect((await list('?repository=fishballapp/taken&run-id=200')).map(({ id }) => id)).toEqual([
        second.id,
      ]);
    });

    it('hashes the name, so it reaches no path', async () => {
      await startServer();
      await uploaded('a.apk', randomBytes(8));
      await uploadIn('fishballapp/other', '8', 'theirs.apk');
      expect((await readdir(join(storeDir, 'repositories'))).toSorted()).toEqual(
        [`${sha256('fishballapp/other')}.json`, `${sha256(VERIFIED.repository)}.json`].toSorted(),
      );
      expect(await list(`?repository=${encodeURIComponent('..%2F..%2Fartifacts/x')}`)).toEqual([]);
    });
  });

  it.each([
    ['a repository with no owner', '?repository=nope'],
    ['a repository with a traversal', `?repository=${encodeURIComponent('../../../etc/passwd')}`],
    ['a repository with a space', `?repository=${encodeURIComponent('a b/c')}`],
    ['a run that is not a number', '?run-id=abc'],
    ['a run with a traversal', `?run-id=${encodeURIComponent('../../artifacts')}`],
    ['a run too long for a path', `?run-id=${'1'.repeat(300)}`],
  ])('refuses %s with a 400', async (_, query) => {
    await startServer();
    expect((await send('GET', `/artifacts${query}`, { headers: AUTH })).status).toBe(400);
  });

  it('answers 503 rather than an empty list while the store is missing', async () => {
    await startServer({ store: diskStore(join(rootDir, 'volume')) });
    expect((await send('GET', '/artifacts', { headers: AUTH })).status).toBe(503);
  });

  it('logs the run and the count, never a token', async () => {
    await startServer();
    const { id } = await uploaded('a.apk', randomBytes(8));
    logLines.length = 0;
    await list();
    const lines = logLines.join('\n');
    expect(lines).toContain('list');
    expect(lines).toContain('count=1');
    expect(lines).not.toContain(id);
    expect(lines).not.toContain(OIDC_TOKEN);
  });
});

describe('who can read and delete', () => {
  const routes = [
    ['GET', '/artifacts'],
    ['DELETE', `/artifacts/${'a'.repeat(43)}`],
  ] as const;

  describe.each(routes)('%s %s', (method, path) => {
    it('answers 401 with no token, a malformed header or another scheme', async () => {
      await startServer();
      expect((await send(method, path)).status).toBe(401);
      for (const authorization of ['Bearer', 'Basic abc', `Bearer ${OIDC_TOKEN} extra`]) {
        const answer = await send(method, path, { headers: { Authorization: authorization } });
        expect(answer.status).toBe(401);
      }
    });

    it('answers 401 with a generic message for a rejected token, and logs the reason', async () => {
      await startServer();
      verification = { kind: 'rejected', reason: 'repository is not private' };
      const answer = await send(method, path, { headers: AUTH });
      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toEqual({ error: 'Token rejected' });
      expect(logLines.join('\n')).toContain('repository is not private');
    });

    it('answers 503, not 401, when the key set is unavailable', async () => {
      await startServer();
      verification = { kind: 'unavailable', reason: 'could not fetch the JWKS' };
      expect((await send(method, path, { headers: AUTH })).status).toBe(503);
    });
  });

  it('checks auth before saying whether a deleted artifact exists', async () => {
    await startServer();
    const { id } = await uploaded('a.apk', randomBytes(8));
    expect((await send('DELETE', `/artifacts/${id}`)).status).toBe(401);
    expect((await send('GET', `/${id}/a.apk`)).status).toBe(200);
  });
});

describe('deleting', () => {
  const remove = (id: string) => send('DELETE', `/artifacts/${id}`, { headers: AUTH });

  it('removes the name and the files together, and the link stops', async () => {
    await startServer();
    const { id, pathname } = await uploaded('a.apk', randomBytes(8));
    const kept = await uploaded('b.apk', randomBytes(8));

    const answer = await remove(id);

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ id, name: 'a.apk' });
    expect((await send('GET', pathname)).status).toBe(404);
    expect(await artifactsOnDisk()).toEqual([kept.id]);
    expect(await namesOnDisk()).toEqual([`${sha256('b.apk')}.json`]);
  });

  it('frees the name for another upload, and a later attempt uncovers an earlier one', async () => {
    await startServer();
    const first = await uploaded('a.apk', randomBytes(8));
    verification = { ...VERIFIED, scope: { ...SCOPE, runAttempt: '2' } };
    const second = await uploaded('a.apk', randomBytes(8));

    expect((await remove(second.id)).status).toBe(200);

    const listed = await send('GET', '/artifacts', { headers: AUTH });
    expect(JSON.parse(listed.body).artifacts).toMatchObject([{ id: first.id }]);
    await uploaded('a.apk', randomBytes(8));
  });

  it('reaches any run of the repository', async () => {
    await startServer();
    const { id } = await uploaded('a.apk', randomBytes(8));
    verification = { ...VERIFIED, scope: { ...SCOPE, runId: '200', runAttempt: '3' } };
    expect((await remove(id)).status).toBe(200);
  });

  it('refuses another repository of the same owner, leaving the artifact as it was', async () => {
    await startServer();
    const { id, pathname } = await uploaded('a.apk', randomBytes(8));
    verification = {
      kind: 'verified',
      repository: 'fishballapp/other',
      scope: { ...SCOPE, repositoryId: '8' },
    };

    const answer = await remove(id);

    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({
      error: 'A job can only delete artifacts of its own repository',
    });
    expect((await send('GET', pathname)).status).toBe(200);
    expect(await artifactsOnDisk()).toEqual([id]);
    expect(logLines.join('\n')).toContain('delete refused');
  });

  it('holds to the verified ID, not the repository that renamed itself to match', async () => {
    await startServer();
    const { id } = await uploaded('a.apk', randomBytes(8));
    verification = {
      kind: 'verified',
      repository: VERIFIED.repository,
      scope: { ...SCOPE, repositoryId: '8' },
    };
    expect((await remove(id)).status).toBe(403);
  });

  it.each([
    ['an unknown ID', async () => 'a'.repeat(43)],
    [
      'an ID that was already deleted',
      async () => {
        const { id } = await uploaded('a.apk', randomBytes(8));
        await remove(id);
        return id;
      },
    ],
    [
      'an ID that was replaced',
      async () => {
        const { id } = await uploaded('a.apk', randomBytes(8));
        await upload('a.apk', randomBytes(8), { query: '&overwrite=true' });
        return id;
      },
    ],
    [
      'an expired artifact',
      async () => {
        const { id } = await uploaded('a.apk', randomBytes(8), '&retention-days=1');
        now = NOW.add({ hours: 24 });
        return id;
      },
    ],
  ])('answers 404 for %s', async (_, makeId) => {
    await startServer();
    const answer = await remove(await makeId());
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toEqual({ error: 'Not found' });
  });

  it('leaves what a replaced ID would otherwise take with it', async () => {
    await startServer();
    const old = await uploaded('a.apk', randomBytes(8));
    const copy = join(rootDir, 'kept-artifact');
    await cp(join(storeDir, 'artifacts', old.id), copy, { recursive: true });
    const replacement = stored(await upload('a.apk', randomBytes(8), { query: '&overwrite=true' }));
    // What a crash mid-replacement leaves: the old artifact's files, its name already moved on.
    await cp(copy, join(storeDir, 'artifacts', old.id), { recursive: true });

    expect((await remove(old.id)).status).toBe(404);
    expect((await send('GET', replacement.pathname)).status).toBe(200);
  });

  it.each([
    ['a short ID', '/artifacts/abc'],
    ['a traversal', '/artifacts/..%2f..%2fetc'],
    ['an extra segment', `/artifacts/${'a'.repeat(43)}/more`],
    ['a query string', `/artifacts/${'a'.repeat(43)}?x=1`],
    ['no ID', '/artifacts/'],
    ['the collection', '/artifacts'],
  ])('answers 404 for %s, with or without a token', async (_, path) => {
    await startServer();
    expect((await send('DELETE', path, { headers: AUTH })).status).toBe(404);
    expect((await send('DELETE', path)).status).toBe(404);
  });

  it('answers 503 while the store is missing', async () => {
    await startServer({ store: diskStore(join(rootDir, 'volume')) });
    expect((await remove('a'.repeat(43))).status).toBe(503);
  });

  it('logs a short token, never the whole of it or the OIDC token', async () => {
    await startServer();
    const { id } = await uploaded('a.apk', randomBytes(8));
    logLines.length = 0;
    await remove(id);
    const lines = logLines.join('\n');
    expect(lines).toContain(id.slice(0, 8));
    expect(lines).not.toContain(id);
    expect(lines).not.toContain(OIDC_TOKEN);
  });

  describe('racing', () => {
    it('with an overwrite of the same name, leaves one artifact and no orphan', async () => {
      await startServer();
      await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const { id } = await uploaded(`${index}.apk`, randomBytes(8));
          const [deleted, replacement] = await Promise.all([
            remove(id),
            upload(`${index}.apk`, randomBytes(8), { query: '&overwrite=true' }),
          ]);
          expect([200, 404]).toContain(deleted.status);
          expect(replacement.status).toBe(201);
          expect((await send('GET', stored(replacement).pathname)).status).toBe(200);
        }),
      );
      expect(await artifactsOnDisk()).toHaveLength(20);
      expect(await namesOnDisk()).toHaveLength(20);
    });

    it('with itself, lets one of them have it', async () => {
      await startServer();
      const { id } = await uploaded('a.apk', randomBytes(8));
      const answers = await Promise.all([remove(id), remove(id), remove(id)]);
      expect(answers.map(({ status }) => status).toSorted()).toEqual([200, 404, 404]);
    });

    it('with a sweep, never breaks either', async () => {
      await startServer();
      for (const index of Array.from({ length: 20 }, (_, index) => index)) {
        const { id } = await uploaded(`${index}.apk`, randomBytes(8));
        const [answer] = await Promise.all([remove(id), sweep()]);
        expect(answer.status).toBe(200);
      }
      await sweep();
      expect(await artifactsOnDisk()).toEqual([]);
    });
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
    await startServer({ store: diskStore(missing) });

    expect((await send('GET', '/healthz')).status).toBe(503);
    const refused = await upload('a.apk', randomBytes(8));
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ error: 'The store is missing' });
    expect((await send('GET', `/${'a'.repeat(43)}/a.apk`)).status).toBe(404);
    expect(await sweep()).toEqual({
      removedNames: 0,
      removedArtifacts: 0,
      removedTemps: 0,
      removedRepositories: 0,
    });
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
  it('removes what it sent straight away and publishes nothing', async () => {
    await startServer();
    const size = 512 * 1024;
    const content = randomBytes(size);
    const { id, url } = await created('cancelled.apk', content);
    const req = openRequest('PUT', url, { 'Content-Length': size });
    req.on('error', () => undefined);
    req.write(content.subarray(0, 64 * 1024));
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(2));

    req.destroy();

    await vi.waitFor(async () => expect(await tempsOnDisk()).toEqual([id]));
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

describe('store.receive', () => {
  const receiveFailure = async (chunks: Uint8Array[], size: number) => {
    await startServer();
    return testServer.run(
      Effect.gen(function* () {
        const { store } = testServer;
        const { id } = yield* store.create({
          scope: SCOPE,
          name: 'a.apk',
          size,
          digest: sha256('a'),
          overwrite: false,
          retentionDays: 1,
        });
        const pending = yield* store.findUpload(id);
        if (pending._tag === 'None') throw new Error('The upload is not there');
        return yield* store
          .receive({ upload: pending.value, stream: Stream.fromIterable(chunks) })
          .pipe(
            Effect.flip,
            Effect.map(failure => ({ failure, id })),
          );
      }),
    );
  };

  it('refuses a body longer than declared, while streaming', async () => {
    const { failure, id } = await receiveFailure([new Uint8Array(4), new Uint8Array(4)], 5);
    expect(failure).toMatchObject({ reason: expect.stringMatching(/longer/) });
    expect(await tempsOnDisk()).toEqual([id]);
    expect(await readdir(uploadedAt(id))).toEqual(['upload.json']);
  });

  it('refuses a body shorter than declared', async () => {
    const { failure, id } = await receiveFailure([new Uint8Array(4)], 5);
    expect(failure).toMatchObject({ reason: expect.stringMatching(/shorter/) });
    expect(await tempsOnDisk()).toEqual([id]);
    expect(await readdir(uploadedAt(id))).toEqual(['upload.json']);
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
    const content = randomBytes(1024);
    const { id, url } = await created('slow.apk', content);
    const req = openRequest('PUT', url, { 'Content-Length': content.length });
    req.on('error', () => undefined);
    req.write(content.subarray(0, 8));
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(2));

    expect(await sweep()).toMatchObject({ removedTemps: 0 });
    expect(await tempsOnDisk()).toHaveLength(2);
    req.destroy();
    await vi.waitFor(async () => expect(await tempsOnDisk()).toEqual([id]));
  });
});

describe('a name in a run attempt', () => {
  const put = (name: string, content: Uint8Array, query = '') => upload(name, content, { query });

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
      digest: sha256('other'),
      query: '&overwrite=true',
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
    await startServer({ store: diskStore(storeDir, 900) });
    freeSpace.bytes = 1000;
    const content = randomBytes(8);
    const { id } = stored(await put('a.apk', content));
    freeSpace.bytes = 0;
    const retry = await put('a.apk', content);
    expect(retry.status).toBe(200);
    expect(stored(retry).id).toBe(id);
  });

  it('refuses a body that is not what its digest says, storing nothing', async () => {
    await startServer();
    const answer = await upload('a.apk', randomBytes(8), { digest: sha256('other') });
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
  /** Every upload's body is in place before any commits, so all that's left to decide is the publish. */
  const race = async (contents: Uint8Array[], query = '') => {
    const uploads = await Promise.all(
      contents.map(async content => {
        const { id, url } = await created('a.apk', content, { query });
        expect((await send('PUT', url, { body: content })).status).toBe(200);
        return { id, content };
      }),
    );
    return Promise.all(
      uploads.map(async ({ id, content }) => ({
        answer: await commit(id, 'a.apk', content, { query }),
        content,
      })),
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

  it('recovers a commit whose client has gone, however far it got', async () => {
    await startServer();
    const content = randomBytes(64 * 1024);
    const { id, url } = await created('a.apk', content);
    await send('PUT', url, { body: content });
    const req = openRequest(
      'POST',
      `/uploads/${id}/commit?${declarationOf('a.apk', content)}`,
      AUTH,
    );
    req.on('error', () => undefined);
    req.end(() => req.destroy());

    const retry = await upload('a.apk', content);
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

    expect(await sweep()).toEqual({
      removedNames: 1,
      removedArtifacts: 1,
      removedTemps: 0,
      removedRepositories: 1,
    });

    expect(await artifactsOnDisk()).toEqual([]);
    expect(await readdir(runsDir())).toEqual([]);
  });

  it('keeps a live name, and the directories above it, beside an expired one', async () => {
    await startServer();
    await uploaded('a.apk', randomBytes(8), '&retention-days=1');
    const kept = await uploaded('b.apk', randomBytes(8), '&retention-days=2');
    now = NOW.add({ hours: 24 });

    expect(await sweep()).toEqual({
      removedNames: 1,
      removedArtifacts: 1,
      removedTemps: 0,
      removedRepositories: 0,
    });

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

  it('removes what a crash left between a deleted name and its artifact', async () => {
    await startServer();
    const { id, pathname } = await uploaded('a.apk', randomBytes(8));
    await rm(nameFile('a.apk'));

    expect((await send('GET', pathname)).status).toBe(404);
    expect((await send('DELETE', `/artifacts/${id}`, { headers: AUTH })).status).toBe(404);
    expect(await sweep()).toMatchObject({ removedArtifacts: 1 });
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await readdir(join(storeDir, 'repositories'))).toEqual([]);
  });

  describe("a repository's record", () => {
    const recordFile = (name = VERIFIED.repository) =>
      join(storeDir, 'repositories', `${sha256(name)}.json`);

    it('stays while a run of it does, and goes with the last one', async () => {
      await startServer();
      const { id } = await uploaded('a.apk', randomBytes(8));
      await uploaded('b.apk', randomBytes(8), '&retention-days=1');
      expect(JSON.parse(await readFile(recordFile(), 'utf8'))).toEqual({
        name: VERIFIED.repository,
        repositoryId: SCOPE.repositoryId,
      });

      now = NOW.add({ hours: 24 });
      expect(await sweep()).toMatchObject({ removedRepositories: 0 });
      expect(existsSync(recordFile())).toBe(true);

      expect((await send('DELETE', `/artifacts/${id}`, { headers: AUTH })).status).toBe(200);
      expect(await sweep()).toMatchObject({ removedRepositories: 1 });
      expect(existsSync(recordFile())).toBe(false);
    });

    it('is swept when a crash left it with nothing, before the name was written', async () => {
      await startServer();
      await mkdir(join(storeDir, 'repositories'));
      await writeFile(
        recordFile(),
        JSON.stringify({ name: VERIFIED.repository, repositoryId: SCOPE.repositoryId }),
      );
      await mkdir(namesDir(), { recursive: true });

      expect(await sweep()).toMatchObject({ removedRepositories: 1 });
      expect(await readdir(runsDir())).toEqual([]);
    });

    it('is swept when nothing can be read from it, and an upload writes it again', async () => {
      await startServer();
      await mkdir(join(storeDir, 'repositories'));
      await writeFile(recordFile(), '{"name":3}');
      await writeFile(join(storeDir, 'repositories', '.DS_Store'), 'junk');

      expect(await sweep()).toMatchObject({ removedRepositories: 2 });

      await uploaded('a.apk', randomBytes(8));
      expect(existsSync(recordFile())).toBe(true);
    });

    it('is written over when a power cut left it corrupt', async () => {
      await startServer();
      await mkdir(join(storeDir, 'repositories'));
      await writeFile(recordFile(), '{"name":3}');
      await uploaded('a.apk', randomBytes(8));
      expect(JSON.parse(await readFile(recordFile(), 'utf8'))).toMatchObject({
        repositoryId: SCOPE.repositoryId,
      });
    });

    it('sweeps what a crash left before a new record moved into place', async () => {
      await startServer();
      now = Temporal.Now.instant();
      await makeOldTemp(`${'a'.repeat(43)}.repository`);
      expect(await sweep()).toMatchObject({ removedTemps: 1 });
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('is not rewritten by an upload that finds it right, leaving no temp', async () => {
      await startServer();
      await uploaded('a.apk', randomBytes(8));
      const { mtimeMs } = await stat(recordFile());
      await new Promise(resolve => setTimeout(resolve, 20));
      await uploaded('b.apk', randomBytes(8));
      expect((await stat(recordFile())).mtimeMs).toBe(mtimeMs);
      expect(await tempsOnDisk()).toEqual([]);
    });

    it('never goes while a publish is making it needed', async () => {
      await startServer();
      await Promise.all(
        Array.from({ length: 25 }, async (_, index) => {
          await Promise.all([uploaded(`${index}.apk`, randomBytes(8)), sweep()]);
          expect(existsSync(recordFile())).toBe(true);
        }),
      );
    });
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
    await startServer({ store: diskStore(file) });
    expect((await send('GET', '/healthz')).status).toBe(503);
  });
});

describe('listing by name', () => {
  it('answers each name once, in name order', async () => {
    await startServer();
    await uploaded('a.zip', randomBytes(8));
    await uploaded('z.zip', randomBytes(8));
    const { status, body } = await send('GET', '/artifacts?name=z.zip&name=a.zip&name=z.zip', {
      headers: AUTH,
    });
    expect(status).toBe(200);
    expect(
      (JSON.parse(String(body)) as { artifacts: { name: string }[] }).artifacts.map(a => a.name),
    ).toEqual(['a.zip', 'z.zip']);
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
    await upload(name, content);
    await upload(name, randomBytes(8));
    verification = { kind: 'rejected', reason: 'wrong org' };
    await upload(name, randomBytes(8));
    // A failing upload: the store's own directory is in the way, so the error names a path.
    verification = VERIFIED;
    await rm(join(storeDir, 'tmp'), { recursive: true, force: true });
    await writeFile(join(storeDir, 'tmp'), 'in the way');
    expect((await upload('another.apk', randomBytes(8))).status).toBe(500);

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
    await upload('a.apk', content);
    await upload('a.apk', randomBytes(8));
    const logged = logLines.join('\n');
    expect(logged).toMatch(/upload already stored.*digest=.*expiresAt=/u);
    const refused = logLines.find(line => line.includes('upload refused'));
    expect(refused).toContain('name taken');
    expect(refused).toContain('repository=fishballapp/private-thing');
    expect(refused).toContain('name=a.apk');
  });

  it("never hold an upload's whole ID, whatever becomes of it", async () => {
    await startServer();
    const content = randomBytes(8);

    const refused = await created('refused.apk', content);
    await send('PUT', refused.url, { body: randomBytes(9) });
    await send('PUT', refused.url, { body: randomBytes(8) });
    await commit(refused.id, 'refused.apk', content);
    const stopped = await created('stopped.apk', content);
    const req = openRequest('PUT', stopped.url, { 'Content-Length': content.length });
    req.on('error', () => undefined);
    req.write(content.subarray(0, 2));
    await vi.waitFor(async () => expect(await tempsOnDisk()).toHaveLength(2));
    req.destroy();
    await vi.waitFor(() => expect(logLines.join('\n')).toContain('upload stopped'));
    const { id, url } = await created('kept.apk', content);
    await send('PUT', url, { body: content });
    await send('PUT', `/uploads/${'a'.repeat(43)}`, { body: content });

    const logged = logLines.join('\n');
    expect(logged).toContain(`${id.slice(0, 8)}…`);
    for (const whole of [refused.id, stopped.id, id, 'a'.repeat(43)]) {
      expect(logged).not.toContain(whole);
    }
  });

  it('do not echo a refused name', async () => {
    await startServer();
    await upload('evil%0Aforged-log-line', randomBytes(8));
    expect(logLines.join('\n')).not.toContain('forged-log-line');
  });
});
