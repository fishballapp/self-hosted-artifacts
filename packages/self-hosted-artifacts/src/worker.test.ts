import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { convertV4MiniflareOptions, type Json, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WORKER } from '../tsdown.config.ts';
import { buildBundle, generateRunnerKeys, removeBundle, UNUSUAL_NAME } from './action-harness.ts';
import { uriEncode } from './protocol.ts';
import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, startFakeS3 } from './s3-fake.ts';
import { closeServer, listenOnLoopback } from './test-support.ts';

// The bundle as it's published, in real workerd. Keys reach it through the Worker in front of its
// network, as GitHub's would, so `oidc.ts` is the same as in production, with no way in for a test.

const ORIGIN = 'https://files.example';
const COMPATIBILITY_DATE = '2026-08-04';
const KID = 'key-1';
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const SESSION_TOKEN = 'fake-session-token';
const ABSENT_ID = 'A'.repeat(43);

/** Everything the Worker sends goes through this, which answers for GitHub and passes on the rest. */
const NETWORK = `
let jwksFetches = 0;
export default {
  async fetch(request, { JWKS, JWKS_DELAY_MS, BUCKET_DELAY_MS }) {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === '/jwks-fetches') return Response.json(jwksFetches);
    if (request.headers.has('traceparent')) return new Response('A trace header', { status: 400 });
    if (hostname === 'token.actions.githubusercontent.com') {
      jwksFetches += 1;
      await scheduler.wait(JWKS_DELAY_MS);
      return Response.json(JSON.parse(JWKS));
    }
    await scheduler.wait(BUCKET_DELAY_MS);
    return fetch(request);
  },
};`;

const encodeBase64url = (bytes: Uint8Array) =>
  bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
const encodeJson = (value: unknown) =>
  encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));

const body = new TextEncoder().encode('x');
const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const declarationOf = (bytes: Uint8Array, extra = '', name = 'a.apk') =>
  `name=${encodeURIComponent(name)}&digest=${digestOf(bytes)}&size=${bytes.length}${extra}`;

describe('the built Worker, in workerd', { timeout: 30_000 }, () => {
  let bundle: string;
  let script: string;
  let keys: CryptoKeyPair;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    bundle = await buildBundle(WORKER, 'worker.js');
    script = await readFile(bundle, 'utf8');
    keys = await generateRunnerKeys();
  });
  afterAll(() => removeBundle(bundle));
  afterEach(async () => {
    await Promise.all(stops.splice(0).map(stop => stop()));
  });

  const signToken = async (claims: object = {}) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signed = `${encodeJson({ alg: 'RS256', kid: KID })}.${encodeJson({
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'self-hosted-artifacts',
      nbf: nowSeconds,
      exp: nowSeconds + 300,
      repository: 'fishballapp/private-thing',
      repository_id: '7',
      run_id: '100',
      run_attempt: '1',
      repository_owner_id: '42',
      repository_visibility: 'private',
      ...claims,
    })}`;
    const signature = await crypto.subtle.sign(
      RSA,
      keys.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${encodeBase64url(new Uint8Array(signature))}`;
  };

  const configOf = (endpoint: string) => ({
    store: { kind: 's3', bucket: 'builds', region: 'auto', endpoint },
    oidcAudience: 'self-hosted-artifacts',
    oidcRepositoryOwnerId: 42,
    linkBases: { home: ORIGIN },
  });

  const CREDENTIALS = {
    AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: FAKE_SECRET_ACCESS_KEY,
  };

  /** One isolate, so everything sent to it shares what a real one's requests would. */
  const startWorker = async ({
    bindings,
    jwksDelayMs = 0,
    bucketDelayMs = 0,
  }: {
    bindings: Record<string, Json>;
    jwksDelayMs?: number;
    bucketDelayMs?: number;
  }) => {
    const logs: string[] = [];
    const jwks = {
      keys: [{ ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: KID }],
    };
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        handleStructuredLogs: ({ message }) => logs.push(message),
        workers: [
          {
            name: 'worker',
            compatibilityDate: COMPATIBILITY_DATE,
            // By contents, as Miniflare can't name a module by a path outside this directory.
            modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
            bindings,
            outboundService: 'network',
          },
          {
            name: 'network',
            routes: ['network.test/*'],
            compatibilityDate: COMPATIBILITY_DATE,
            modules: true,
            script: NETWORK,
            bindings: {
              JWKS: JSON.stringify(jwks),
              JWKS_DELAY_MS: jwksDelayMs,
              BUCKET_DELAY_MS: bucketDelayMs,
            },
          },
        ],
      }),
    );
    await miniflare.ready;
    stops.push(() => miniflare.dispose());
    return {
      logs,
      request: async (
        path: string,
        init: { method?: string; token?: string; body?: string } = {},
      ) => {
        const { token, method, body } = init;
        const response = await miniflare.dispatchFetch(`${ORIGIN}${path}`, {
          ...(method === undefined ? {} : { method }),
          headers: {
            ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
        });
        return {
          status: response.status,
          headers: response.headers,
          text: await response.text(),
        };
      },
      jwksFetches: async () =>
        (await miniflare.dispatchFetch('https://network.test/jwks-fetches')).json(),
    };
  };

  const startFakeBucket = async () => {
    const fake = await startFakeS3({ isPublic: false });
    stops.push(fake.stop);
    return fake;
  };

  type Worker = Awaited<ReturnType<typeof startWorker>>;

  /** A job's three steps, with the body going straight to the bucket as the job's would. */
  const uploadThrough = async (
    { request }: Worker,
    token: string,
    bytes = body,
    extra = '',
    name = 'a.apk',
  ) => {
    const declaration = declarationOf(bytes, extra, name);
    const created = await request(`/uploads?${declaration}`, { method: 'POST', token });
    expect(created.status).toBe(201);
    const { upload } = JSON.parse(created.text) as {
      upload: { kind: string; id: string; url: string; headers: Record<string, string> };
    };
    expect(upload.kind).toBe('single');
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    expect(put.status).toBe(200);
    const committed = await request(`/uploads/${upload.id}/commit?${declaration}`, {
      method: 'POST',
      token,
    });
    expect(committed.status).toBe(201);
    return { id: upload.id, url: upload.url, stored: JSON.parse(committed.text) };
  };

  describe('with a bucket', () => {
    const startOverFake = async (
      options: { jwksDelayMs?: number; bucketDelayMs?: number } = {},
    ) => {
      const fake = await startFakeBucket();
      const worker = await startWorker({
        bindings: {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(configOf(fake.endpoint)),
          ...CREDENTIALS,
        },
        ...options,
      });
      return { fake, worker };
    };

    it('answers what needs no token', async () => {
      const { worker } = await startOverFake();
      const health = await worker.request('/healthz');
      expect([health.status, JSON.parse(health.text)]).toEqual([200, { status: 'ok' }]);
      const noToken = await worker.request(`/uploads?${declarationOf(body)}`, { method: 'POST' });
      expect([noToken.status, JSON.parse(noToken.text)]).toEqual([
        401,
        { error: 'Token rejected' },
      ]);
      expect((await worker.request(`/${ABSENT_ID}/a.apk`)).status).toBe(404);
      expect((await worker.request(`/${ABSENT_ID}/a.apk`, { method: 'HEAD' })).status).toBe(404);
      expect((await worker.request('/nothing/here/at-all', { method: 'POST' })).status).toBe(404);
    });

    it('takes a verified job from its first request to a link, and to its deletion', async () => {
      const { worker } = await startOverFake();
      const token = await signToken();
      const { id, stored } = await uploadThrough(worker, token);
      expect(stored.links).toEqual({ home: `${ORIGIN}/${id}/a.apk` });

      const read = await worker.request(`/${id}/a.apk`);
      expect(read.status).toBe(302);
      expect(read.headers.get('cache-control')).toBe('no-store');
      const location = read.headers.get('location') ?? '';
      expect(location).toContain('X-Amz-Signature=');
      const fromBucket = await fetch(location);
      expect(fromBucket.status).toBe(200);
      expect(await fromBucket.text()).toBe('x');

      const head = await worker.request(`/${id}/a.apk`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('location')).toBeNull();
      expect(head.headers.get('content-length')).toBe('1');
      expect(head.text).toBe('');

      const listed = await worker.request('/artifacts', { token });
      expect(
        JSON.parse(listed.text).artifacts.map(({ id: listedId }: { id: string }) => listedId),
      ).toEqual([id]);

      const deleted = await worker.request(`/artifacts/${id}`, { method: 'DELETE', token });
      expect(deleted.status).toBe(200);
      expect((await worker.request(`/${id}/a.apk`)).status).toBe(404);
    });

    it('reaches the bucket for any name upstream takes', async () => {
      const { worker } = await startOverFake();
      const name = `${UNUSUAL_NAME}.apk`;
      const { id, stored } = await uploadThrough(worker, await signToken(), body, '', name);
      expect(stored.links).toEqual({ home: `${ORIGIN}/${id}/${uriEncode(name)}` });
      const read = await worker.request(`/${id}/${uriEncode(name)}`);
      expect(read.status).toBe(302);
      expect((await fetch(read.headers.get('location') ?? '')).status).toBe(200);
      expect((await worker.request(`/${id}/%ZZ`)).status).toBe(404);
    });

    it('replaces a name with `If-Match`, so `accept-encoding: identity` reached the bucket', async () => {
      const { worker } = await startOverFake();
      const token = await signToken();
      const first = await uploadThrough(worker, token);
      const second = await uploadThrough(
        worker,
        token,
        new TextEncoder().encode('y'),
        '&overwrite=true',
      );
      expect((await worker.request(`/${second.id}/a.apk`)).status).toBe(302);
      expect((await worker.request(`/${first.id}/a.apk`)).status).toBe(404);
    });

    it('takes a job in parts from 1 GiB, one batch at most, with its upload ID in no log', async () => {
      const { worker } = await startOverFake();
      const token = await signToken();
      const size = 1024 ** 3;
      const part = Buffer.alloc(16 * 1024 ** 2, 1);
      const md5 = createHash('md5').update(part).digest('base64');
      const declaration = `name=a.bin&digest=${'a'.repeat(64)}&size=${size}`;

      const created = await worker.request(`/uploads?${declaration}`, { method: 'POST', token });
      expect(created.status).toBe(201);
      const { upload } = JSON.parse(created.text) as {
        upload: { kind: string; id: string; uploadId: string; partSize: number };
      };
      expect(upload).toMatchObject({ kind: 'multipart', partSize: part.length });
      const { id, uploadId } = upload;

      const parts = Array.from({ length: 64 }, (_, index) => ({ partNumber: index + 1, md5 }));
      const tooMany = await worker.request(`/uploads/${id}/parts?${declaration}`, {
        method: 'POST',
        token,
        body: JSON.stringify({ uploadId, parts: [...parts, ...parts] }),
      });
      expect(tooMany.status).toBe(400);

      const signing = await worker.request(`/uploads/${id}/parts?${declaration}`, {
        method: 'POST',
        token,
        body: JSON.stringify({ uploadId, parts }),
      });
      expect(signing.status).toBe(200);
      const { parts: signed } = JSON.parse(signing.text) as {
        parts: { partNumber: number; url: string; headers: Record<string, string> }[];
      };
      const sent = await Promise.all(
        signed.map(async ({ partNumber, url, headers }) => {
          const answer = await fetch(url, { method: 'PUT', headers, body: part });
          expect(answer.status).toBe(200);
          return { partNumber, etag: answer.headers.get('etag') };
        }),
      );

      const committed = await worker.request(`/uploads/${id}/commit?${declaration}`, {
        method: 'POST',
        token,
        body: JSON.stringify({ uploadId, parts: sent }),
      });
      expect(committed.status).toBe(201);
      const head = await worker.request(`/${id}/a.bin`, { method: 'HEAD' });
      expect(head.headers.get('content-length')).toBe(String(size));

      const logged = worker.logs.join('\n');
      expect(logged).toContain(`"token":"${id.slice(0, 8)}…"`);
      expect(logged).not.toContain(uploadId);
    });

    it('keeps the signing keys across requests', async () => {
      const { worker } = await startOverFake();
      const token = await signToken();
      expect((await worker.request('/artifacts', { token })).status).toBe(200);
      expect((await worker.request('/artifacts', { token })).status).toBe(200);
      expect(await worker.jwksFetches()).toBe(1);
    });

    it('turns away a token signed by the wrong key, and one for another audience', async () => {
      const { worker } = await startOverFake();
      const otherKeys = await generateRunnerKeys();
      const [header = '', claims = ''] = (await signToken()).split('.');
      const forged = await crypto.subtle.sign(
        RSA,
        otherKeys.privateKey,
        new TextEncoder().encode(`${header}.${claims}`),
      );
      const forgedToken = `${header}.${claims}.${encodeBase64url(new Uint8Array(forged))}`;
      expect((await worker.request('/artifacts', { token: forgedToken })).status).toBe(401);
      const wrongAudience = await signToken({ aud: 'something-else' });
      expect((await worker.request('/artifacts', { token: wrongAudience })).status).toBe(401);
    });

    it('answers a request that arrives while the isolate has just started', async () => {
      const { worker } = await startOverFake();
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => worker.request('/healthz')),
      );
      expect(answers.map(({ status }) => status)).toEqual(Array.from({ length: 8 }, () => 200));
    });

    /**
     * What workerd cancels as hung is a request waiting on another's work, as soon as it has nothing of
     * its own in flight. So all of these need keys at once, and the first to finish has no work left.
     */
    it('answers requests that all need the signing keys at once', async () => {
      const { worker } = await startOverFake({ jwksDelayMs: 200, bucketDelayMs: 200 });
      const wrongAudience = await signToken({ aud: 'something-else' });
      const token = await signToken();
      const [refused, ...verified] = await Promise.all([
        worker.request('/artifacts', { token: wrongAudience }),
        worker.request(`/uploads?${declarationOf(body)}`, { method: 'POST', token }),
        worker.request('/artifacts', { token }),
        worker.request('/artifacts', { token }),
      ]);
      expect(refused?.status).toBe(401);
      expect(verified.map(({ status }) => status)).toEqual([201, 200, 200]);
    });

    it('answers many at once with the keys in place, each with its own', async () => {
      const { worker } = await startOverFake({ bucketDelayMs: 20 });
      const token = await signToken();
      const { id } = await uploadThrough(worker, token);
      const answers = await Promise.all(
        Array.from({ length: 24 }, (_, index) => {
          if (index % 3 === 0) return worker.request(`/${id}/a.apk`);
          return index % 3 === 1
            ? worker.request('/artifacts', { token })
            : worker.request(`/${ABSENT_ID}/a.apk`);
        }),
      );
      expect(answers.map(({ status }) => status)).toEqual(
        Array.from({ length: 24 }, (_, index) => [302, 200, 404][index % 3]),
      );
    });

    it("doesn't follow a bucket's redirect", async () => {
      let requests = 0;
      const redirecting = createServer((req, res) => {
        // Anything on the machine probing loopback ports asks for `/`, which no store request does.
        if (req.url === '/') return void res.writeHead(404).end();
        requests += 1;
        return void res
          .writeHead(301, { location: `http://127.0.0.1:9/elsewhere${requests}` })
          .end();
      });
      const endpoint = await listenOnLoopback(redirecting);
      stops.push(() => closeServer(redirecting));
      const worker = await startWorker({
        bindings: {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(configOf(endpoint)),
          ...CREDENTIALS,
        },
      });
      const answer = await worker.request(`/${ABSENT_ID}/a.apk`);
      expect([answer.status, JSON.parse(answer.text)]).toEqual([500, { error: 'Internal error' }]);
      expect(requests).toBe(1);
    });

    it('takes its config as a JSON variable too, which is how wrangler.jsonc can write it', async () => {
      const fake = await startFakeBucket();
      const worker = await startWorker({
        bindings: { SELF_HOSTED_ARTIFACTS_CONFIG: configOf(fake.endpoint), ...CREDENTIALS },
      });
      expect((await worker.request('/healthz')).status).toBe(200);
    });

    it('takes `host` and `port`, as `serve` does, and ignores them', async () => {
      const fake = await startFakeBucket();
      const worker = await startWorker({
        bindings: {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify({
            ...configOf(fake.endpoint),
            host: '127.0.0.1',
            port: 8420,
          }),
          ...CREDENTIALS,
        },
      });
      expect((await worker.request('/healthz')).status).toBe(200);
    });
  });

  describe('holding no secret in a log', () => {
    it('logs nothing secret or signed, whatever the request', async () => {
      const fake = await startFakeBucket();
      const worker = await startWorker({
        bindings: {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(configOf(fake.endpoint)),
          ...CREDENTIALS,
          AWS_SESSION_TOKEN: SESSION_TOKEN,
        },
      });
      const token = await signToken();
      const { id, url } = await uploadThrough(worker, token);
      const read = await worker.request(`/${id}/a.apk`);
      await worker.request(`/${id}/a.apk`, { method: 'HEAD' });
      await worker.request('/artifacts', { token });
      await worker.request('/artifacts', { token: await signToken({ aud: 'something-else' }) });
      await worker.request(`/artifacts/${id}`, { method: 'DELETE', token });

      expect(worker.logs.length).toBeGreaterThan(4);
      const logged = worker.logs.join('\n');
      expect(logged).toContain(`"token":"${id.slice(0, 8)}…"`);
      for (const secret of [
        FAKE_SECRET_ACCESS_KEY,
        SESSION_TOKEN,
        token,
        id,
        url,
        read.headers.get('location') ?? 'no location',
        'X-Amz-Signature',
        'Signature=',
        'authorization',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });

    it('logs a refusal by its code, with the key shortened', async () => {
      const fake = await startFakeBucket();
      const worker = await startWorker({
        bindings: {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(configOf(fake.endpoint)),
          AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: 'not-the-secret-the-bucket-holds',
        },
      });
      const answer = await worker.request(`/${ABSENT_ID}/a.apk`);
      expect([answer.status, JSON.parse(answer.text)]).toEqual([500, { error: 'Internal error' }]);
      const listed = await worker.request('/artifacts', { token: await signToken() });
      expect(listed.status).toBe(500);

      const logged = worker.logs.join('\n');
      expect(logged).toContain('SignatureDoesNotMatch');
      expect(logged).toContain(`artifacts/${ABSENT_ID.slice(0, 8)}…`);
      for (const secret of [
        ABSENT_ID,
        'not-the-secret-the-bucket-holds',
        FAKE_ACCESS_KEY_ID,
        'StringToSign',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  describe('when it is set up wrongly', () => {
    const VALUE = 'a-value-that-must-stay-out-of-this';
    const CONFIG = configOf('https://bucket.example');

    it.each<[string, Record<string, Json>, string]>([
      [
        'a disk store',
        {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify({
            ...CONFIG,
            store: { kind: 'disk', dir: `/${VALUE}` },
          }),
          ...CREDENTIALS,
        },
        'SELF_HOSTED_ARTIFACTS_CONFIG has to have an "s3" store, as a Worker has no disk',
      ],
      ['no config', CREDENTIALS, "SELF_HOSTED_ARTIFACTS_CONFIG isn't set"],
      [
        'a config that is not JSON',
        { SELF_HOSTED_ARTIFACTS_CONFIG: `{ ${VALUE}`, ...CREDENTIALS },
        "SELF_HOSTED_ARTIFACTS_CONFIG has to be the server's config, as JSON",
      ],
      [
        'a bad setting',
        {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify({ ...CONFIG, linkBases: { home: VALUE } }),
          ...CREDENTIALS,
        },
        'SELF_HOSTED_ARTIFACTS_CONFIG is invalid at linkBases.home',
      ],
      [
        'an unknown setting',
        {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify({ ...CONFIG, secretAccessKey: VALUE }),
          ...CREDENTIALS,
        },
        'SELF_HOSTED_ARTIFACTS_CONFIG is invalid at secretAccessKey',
      ],
      [
        'no keys',
        { SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(CONFIG) },
        'No S3 credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN with temporary ones',
      ],
      [
        'half the keys',
        {
          SELF_HOSTED_ARTIFACTS_CONFIG: JSON.stringify(CONFIG),
          AWS_SECRET_ACCESS_KEY: VALUE,
        },
        'No S3 credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN with temporary ones',
      ],
    ])('answers every request with a 500 that says so, for %s', async (_, bindings, message) => {
      const worker = await startWorker({ bindings });
      for (const [path, method] of [
        ['/healthz', 'GET'],
        ['/uploads', 'POST'],
        [`/${ABSENT_ID}/a.apk`, 'GET'],
      ] as const) {
        const answer = await worker.request(path, { method });
        expect([answer.status, JSON.parse(answer.text)]).toEqual([500, { error: message }]);
        expect(answer.text).not.toContain(VALUE);
      }
      const logged = worker.logs.join('\n');
      expect(logged).toContain(JSON.stringify(message).slice(1, -1));
      expect(logged).not.toContain(VALUE);
    });
  });

  describe('the bundle', () => {
    it('imports only what workerd has, and never touches `Temporal`', () => {
      const imports = Array.from(script.matchAll(/\bfrom\s*"([^"]+)"/gu), ([, name]) => name);
      expect(new Set(imports)).toEqual(new Set(['cloudflare:workers', 'node:crypto']));
      expect(script).not.toMatch(/\bTemporal\b/u);
    });

    it('comes out byte-identical from a second build', async () => {
      const again = await buildBundle(WORKER, 'worker.js');
      try {
        expect(digestOf(await readFile(again))).toBe(digestOf(new TextEncoder().encode(script)));
      } finally {
        await removeBundle(again);
      }
    });
  });
});
