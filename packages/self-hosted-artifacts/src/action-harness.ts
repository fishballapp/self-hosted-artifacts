import { type ExecFileException, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { build, type UserConfig } from 'tsdown';
import { type Config, type S3StoreConfig, ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { unescapeXml } from './s3-bucket.ts';
import { makeS3Target } from './s3-client.ts';
import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, rawS3Client, startFakeS3 } from './s3-fake.ts';
import { encodeS3Path } from './s3-sigv4.ts';
import { openFileToSend } from './sending.ts';
import { makeServerTarget } from './server-client.ts';
import {
  closeServer,
  listenOnLoopback,
  startBucketTestServer,
  startTestServer,
} from './test-support.ts';

/**
 * One bundle rather than the whole package, as test files run side by side and a build cleans its
 * output folder: each file builds only the action it runs.
 */
/** A process killed by a signal has no code, and must not read as having succeeded. */
export const exitCodeOf = (error: ExecFileException | null) => {
  if (error === null) return 0;
  return typeof error.code === 'number' ? error.code : 128;
};

/**
 * A script for `--import` that prints a process's peak memory. On Linux, `maxRSS` carries over the
 * parent's peak through fork and exec, so it would report this test run's own memory.
 */
export const PEAK_REPORTER = `
import { existsSync, readFileSync } from 'node:fs';
process.on('exit', () => {
  const status = existsSync('/proc/self/status') ? readFileSync('/proc/self/status', 'utf8') : '';
  const peakKib = /VmHWM:\\s+(\\d+)/.exec(status)?.[1] ?? process.resourceUsage().maxRSS;
  process.stderr.write('peak-kib=' + peakKib + '\\n');
});
`;

/**
 * A suite's bundle with a lower threshold for going in parts, which is the only thing about parts that
 * can be small: a real bucket holds a part's size to its own minimum, and writing a real GiB for every
 * scenario would be slow. A suite's own process has the same through `vi.mock` of `protocol.ts`, and
 * nothing in the published package can reach it.
 */
export const withSmallMultipart = (config: UserConfig): UserConfig => ({
  ...config,
  plugins: [
    {
      name: 'small-multipart',
      transform: (code: string, id: string) => {
        if (!id.endsWith('/src/protocol.ts')) return undefined;
        const declared = 'MULTIPART_FROM_BYTES = 1024 ** 3';
        if (!code.includes(declared)) throw new Error(`protocol.ts no longer says ${declared}`);
        return code.replace(declared, `MULTIPART_FROM_BYTES = ${TEST_MULTIPART_FROM_BYTES}`);
      },
    },
  ],
});

/**
 * Builds an action into a folder of its own, and answers with the file. Test files run in parallel, and
 * a build empties its folder first, so sharing one would pull a bundle out from under another file's step.
 */
export const buildBundle = async (config: UserConfig, file = 'action.mjs') => {
  const outDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bundle-'));
  await build({
    ...config,
    outDir,
    config: false,
    cwd: new URL('..', import.meta.url).pathname,
    logLevel: 'silent',
  });
  return join(outDir, file);
};

export const removeBundle = (bundle: string) =>
  rm(dirname(bundle), { recursive: true, force: true });

/** What `withSmallMultipart` makes it, and what each suite's `vi.mock` says too. */
export const TEST_MULTIPART_FROM_BYTES = 32 * 1024 ** 2;

/**
 * What a job in parts stays under, whatever the file's size: four parts in flight, and `fetch`'s copy of
 * each that the GC hasn't got to yet. `DECISIONS.md` has what was measured.
 */
export const PEAK_IN_PARTS_BYTES = 640 * 1024 ** 2;

export const AUDIENCE = 'custom-audience';
export const REQUEST_TOKEN = 'runner-request-token';
const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

export type RunClaims = {
  repository: string;
  repository_id: string;
  run_id: string;
  run_attempt: string;
};

export const CURRENT_RUN: RunClaims = {
  repository: 'fishballapp/private-thing',
  repository_id: '7',
  run_id: '100',
  run_attempt: '1',
};

/**
 * Every way to store runs through the same scenarios wherever they should behave the same: a server
 * with a disk, a job with a bucket's keys, and a server in front of a bucket.
 */
/** All that upstream's rule lets through, which each place a name goes has to carry. */
export const UNUSUAL_NAME = "a build [v1] (x+y) & z=1; 100% #2 ~'你好";

export const TARGET_KINDS = ['server', 's3', 'server-s3'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export type Stored = {
  id: string;
  name: string;
  digest: string;
  size: number;
  expiresAt: string;
  links: Record<string, string>;
};

/** What a proxy in front of a target does with a request: answer it, pass it on and lose the answer, or never answer. */
export type Interception = { status: number; message: string } | 'lose-answer' | 'hang' | undefined;

/**
 * Set these to run the suites against a real store, such as a throwaway MinIO: each test gets a new
 * bucket, with the README's own policy on it, and removes it after. A store with no bucket policies,
 * such as R2, sets `S3_TEST_BUCKET_POLICIES=off`: its links then go through a proxy that signs them.
 */
const REAL_S3 =
  process.env.S3_TEST_ENDPOINT === undefined
    ? undefined
    : {
        endpoint: process.env.S3_TEST_ENDPOINT,
        accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
        hasBucketPolicies: process.env.S3_TEST_BUCKET_POLICIES !== 'off',
      };
const S3_REGION = 'us-east-1';

/** The bucket policy the README documents, so the real store's tests hold that text. */
const readmeBucketPolicy = async (bucket: string) => {
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  const policy = /```json\n\s*(\{[^`]*"s3:GetObject"[^`]*\})\n\s*```/u.exec(readme)?.[1];
  if (policy === undefined) throw new Error('The README holds no bucket policy');
  return policy.replaceAll('YOUR-BUCKET', bucket);
};

/**
 * Everything around a step on a runner, for one test: its directories, the runner's token endpoint
 * signing real tokens for whichever run the test says this is, and a real target for it to use.
 */
export const startRunner = async ({ keys }: { keys: CryptoKeyPair }) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-runner-'));
  const workDir = join(rootDir, 'work');
  const runnerTemp = join(rootDir, 'runner-temp');
  const outputPath = join(rootDir, 'github-output');
  const storeDir = join(rootDir, 'store');
  await Promise.all([workDir, runnerTemp, storeDir].map(directory => mkdir(directory)));

  let claims = CURRENT_RUN;
  let stopArtifactServer: () => Promise<void> = async () => undefined;
  const tokenRequests: { url: URL; authorization: string | undefined }[] = [];
  const stops: (() => Promise<void>)[] = [];

  const signToken = async () => {
    const nowSeconds = Temporal.Now.instant().epochMilliseconds / 1000;
    const signed = `${encodeJson({ alg: 'RS256', kid: 'key-1' })}.${encodeJson({
      iss: 'https://token.actions.githubusercontent.com',
      aud: AUDIENCE,
      nbf: nowSeconds,
      exp: nowSeconds + 300,
      repository_owner_id: '42',
      repository_visibility: 'private',
      ...claims,
    })}`;
    const signature = await crypto.subtle.sign(
      RSA,
      keys.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${new Uint8Array(signature).toBase64({
      alphabet: 'base64url',
      omitPadding: true,
    })}`;
  };

  const tokenServer = createServer((req, res) => {
    // Anything on the machine probing loopback ports lands here too, so answer only the endpoint.
    if (!req.url?.startsWith('/token')) return void res.writeHead(404).end();
    tokenRequests.push({
      url: new URL(req.url, 'http://localhost'),
      authorization: req.headers.authorization,
    });
    void signToken().then(value => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value }));
    });
    return undefined;
  });
  const tokenRequestUrl = `${await listenOnLoopback(tokenServer)}/token?api-version=2.0`;

  const runnerEnv = {
    PATH: process.env.PATH,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outputPath,
    GITHUB_WORKSPACE: workDir,
    ACTIONS_ID_TOKEN_REQUEST_URL: tokenRequestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
  };

  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    kid: 'key-1',
    use: 'sig',
    alg: 'RS256',
  };

  /** As a job has them on a runner, whichever target it uses. */
  const jobEnv = () => ({
    GITHUB_REPOSITORY: claims.repository,
    GITHUB_REPOSITORY_ID: claims.repository_id,
    GITHUB_RUN_ID: claims.run_id,
    GITHUB_RUN_ATTEMPT: claims.run_attempt,
  });

  const serverConfig = (overrides: Partial<Config> = {}) =>
    ({
      store: { kind: 'disk', dir: storeDir, minFreeBytes: 0 },
      oidcAudience: AUDIENCE,
      oidcRepositoryOwnerId: '42',
      // A runner can't reach these, so a client that fetched by link would fail.
      linkBases: { home: 'http://127.0.0.1:1', tailscale: 'https://files.example' },
      host: '127.0.0.1',
      port: 0,
      defaultRetentionDays: 7,
      maxRetentionDays: 30,
      maxFileBytes: 1024 ** 3,
      ...overrides,
    }) satisfies Config;

  const verifierOf = (config: Config) =>
    TokenVerifier.layer.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async () => Response.json({ keys: [jwk] })),
      ),
    );

  const startArtifactServer = async (
    overrides: Partial<Config> = {},
    verifier?: Layer.Layer<TokenVerifier>,
  ) => {
    const config = serverConfig(overrides);
    const testServer = await startTestServer({
      config,
      verifier: verifier ?? verifierOf(config),
    });
    stopArtifactServer = testServer.stop;
    return `http://127.0.0.1:${testServer.port}`;
  };

  /** What the server wrote to its log, for a test to read for what must not be there. */
  const serverLog: string[] = [];

  const startBucketServer = async (
    store: S3StoreConfig,
    credentials: Readonly<Record<string, string>>,
  ) => {
    const config = serverConfig({ store });
    const testServer = await startBucketTestServer({
      config,
      store,
      verifier: verifierOf(config),
      credentials,
      onLog: line => serverLog.push(line),
    });
    stops.push(testServer.stop);
    return `http://127.0.0.1:${testServer.port}`;
  };

  /**
   * A proxy in front of a target, to do something the target wouldn't. It passes the `Host` it was
   * sent, which a signature holds, and the body as it comes.
   */
  const startProxy = async ({
    origin,
    intercept,
    answerBody,
  }: {
    origin: string;
    intercept: (request: IncomingMessage) => Interception;
    answerBody: (message: string) => string;
  }) => {
    const backend = new URL(origin);
    const proxy = createServer((req, res) => {
      // As on a fake server: a probe of a loopback port asks for `/`, and no client does.
      if (req.url === '/') return void res.writeHead(404).end();
      const interception = intercept(req);
      if (interception === 'hang') return void req.resume();
      if (interception !== undefined && interception !== 'lose-answer') {
        req.resume();
        return void res.writeHead(interception.status).end(answerBody(interception.message));
      }
      const forward = httpRequest(
        {
          host: backend.hostname,
          port: backend.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        answer => {
          // Cut off partway, as the client's connection then has nothing more coming.
          answer.on('error', () => res.destroy());
          if (interception === 'lose-answer') {
            answer.resume();
            answer.on('end', () => res.destroy());
            return;
          }
          res.writeHead(answer.statusCode ?? 500, answer.headers);
          answer.pipe(res);
        },
      );
      // A store can refuse from the headers and close on a body it's still being sent, so this can
      // fail after its answer, which has already gone on to the client.
      forward.on('error', () => {
        if (!res.headersSent) res.destroy();
      });
      // A client that stops sending, as one does once it's refused, leaves nothing to forward.
      req.on('close', () => {
        if (!req.complete) forward.destroy();
      });
      req.pipe(forward);
      return undefined;
    });
    stops.push(() => closeServer(proxy));
    return listenOnLoopback(proxy);
  };

  /** What's the same of a server whichever store it has: the routes, as a job and a person use them. */
  const serverRoutes = (
    realUrl: string,
    onInterpose: (intercept: (request: IncomingMessage) => Interception) => void,
  ) => {
    let url = realUrl;
    const authorized = async () => ({ Authorization: `Bearer ${await signToken()}` });
    /** The three steps a job takes, each token minted as it would be. */
    const post = async (name: string, body: Blob, run: Partial<RunClaims>) => {
      const hash = createHash('sha256');
      for await (const chunk of body.stream()) hash.update(chunk);
      const declaration = `name=${encodeURIComponent(name)}&digest=${hash.digest('hex')}&size=${body.size}`;
      claims = { ...CURRENT_RUN, ...run };
      const created = await fetch(`${url}/uploads?${declaration}`, {
        method: 'POST',
        headers: await authorized(),
      });
      if (created.status !== 201) throw new Error(`Storing ${name}: ${created.status}`);
      const { upload } = (await created.json()) as {
        upload: { kind: string; id: string; url: string; headers: Record<string, string> };
      };
      if (upload.kind !== 'single') throw new Error(`${name} is too big for this shortcut`);
      const sent = await fetch(new URL(upload.url, url), {
        method: 'PUT',
        headers: upload.headers,
        body,
      });
      if (!sent.ok) throw new Error(`Sending ${name}: ${sent.status}`);
      const committed = await fetch(`${url}/uploads/${upload.id}/commit?${declaration}`, {
        method: 'POST',
        headers: await authorized(),
      });
      claims = CURRENT_RUN;
      if (committed.status !== 201) throw new Error(`Committing ${name}: ${committed.status}`);
      return (await committed.json()) as Stored;
    };
    return {
      inputs: () => ({ 'INPUT_SERVER-URL': url, INPUT_AUDIENCE: AUDIENCE }),
      flags: () => ['--server-url', url, '--audience', AUDIENCE],
      env: () => ({}),
      /** Straight to the real server, as the job that uploaded would, with a real token. */
      store: (name: string, content: Uint8Array, run: Partial<RunClaims> = {}) =>
        post(name, new Blob([new Uint8Array(content)]), run),
      /** Through the real client, in parts if it's big enough, so the test's own memory stays out of it. */
      storeFromDisk: async (name: string, path: string) => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const target = yield* makeServerTarget({ serverUrl: url, audience: AUDIENCE });
            const file = yield* openFileToSend(path);
            return yield* target.send({ file, name, overwrite: false, retentionDays: 0 });
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                FetchHttpClient.layer,
                Layer.succeed(HttpClient.TracerPropagationEnabled, false),
                NodeFileSystem.layer,
                ConfigProvider.layer(ConfigProvider.fromUnknown(runnerEnv)),
              ),
            ),
          ),
        );
      },
      /** What the run holds, latest attempt of each name. */
      list: async (run: Partial<RunClaims> = {}) => {
        claims = { ...CURRENT_RUN, ...run };
        const response = await fetch(`${url}/artifacts`, { headers: await authorized() });
        claims = CURRENT_RUN;
        return ((await response.json()) as { artifacts: Stored[] }).artifacts;
      },
      linkOf: ({ id, name }: { id: string; name: string }) =>
        `${realUrl}/${id}/${encodeURIComponent(name)}`,
      /** A link from an output: its base is one a runner can't reach, so the path goes to the server. */
      reachable: (link: string) => `${realUrl}${new URL(link).pathname}`,
      goneLinkStatuses: [404],
      /** From here on, a step goes through a proxy. */
      interpose: async (intercept: (request: IncomingMessage) => Interception) => {
        onInterpose(intercept);
        url = await startProxy({
          origin: realUrl,
          intercept,
          answerBody: message => JSON.stringify({ error: message }),
        });
      },
      removeProxy: () => {
        onInterpose(() => undefined);
        url = realUrl;
      },
      isDeleteOf:
        ({ id }: { id: string }) =>
        ({ method, url: path }: IncomingMessage) =>
          method === 'DELETE' && path?.endsWith(id) === true,
    };
  };

  const startServerTarget = async (
    overrides: Partial<Config> = {},
    verifier?: Layer.Layer<TokenVerifier>,
  ) => ({
    ...serverRoutes(await startArtifactServer(overrides, verifier), () => undefined),
    kind: 'server' as const,
    /** Replaces what's stored behind its digest's back. */
    replaceBytes: ({ id }: Stored, bytes: Uint8Array) =>
      writeFile(join(storeDir, 'artifacts', id, 'data'), bytes),
    readBytes: ({ id }: Stored) => readFile(join(storeDir, 'artifacts', id, 'data')),
    // The request that carries the body.
    isUpload: ({ method, url: path }: IncomingMessage) =>
      method === 'PUT' && path?.startsWith('/uploads/') === true,
  });

  /** The store's own answer to a link, for a bucket no anonymous read can reach here. */
  const startSigningProxy = async (raw: ReturnType<typeof rawS3Client>) => {
    const proxy = createServer((req, res) => {
      const key = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname.slice(1));
      void raw.send(req.method ?? 'GET', key).then(async answer => {
        const {
          'content-encoding': _encoding,
          'content-length': _length,
          ...headers
        } = Object.fromEntries(answer.headers);
        res.writeHead(answer.status, headers).end(Buffer.from(await answer.arrayBuffer()));
      });
    });
    stops.push(() => closeServer(proxy));
    return listenOnLoopback(proxy);
  };

  /** A bucket of its own, on a fake or a real store. Only a public one gets the README's policy. */
  const startBucket = async ({ isPublic }: { isPublic: boolean }) => {
    const fake = REAL_S3 === undefined ? await startFakeS3({ isPublic }) : undefined;
    if (fake !== undefined) stops.push(fake.stop);
    const realEndpoint = REAL_S3?.endpoint ?? fake?.endpoint ?? '';
    const accessKeyId = REAL_S3?.accessKeyId ?? FAKE_ACCESS_KEY_ID;
    const secretAccessKey = REAL_S3?.secretAccessKey ?? FAKE_SECRET_ACCESS_KEY;
    const bucket = `test-${crypto.randomUUID()}`;
    const raw = rawS3Client({
      endpoint: realEndpoint,
      bucket,
      credentials: { accessKeyId, secretAccessKey: Redacted.make(secretAccessKey) },
      region: S3_REGION,
    });
    if (REAL_S3 !== undefined) {
      const created = await raw.send('PUT', '');
      if (!created.ok) throw new Error(`Creating ${bucket}: ${await created.text()}`);
      stops.push(async () => {
        await Promise.all((await raw.keys()).map(key => raw.send('DELETE', key)));
        // R2 won't remove a bucket that holds an upload nobody finished.
        const open = await (await raw.send('GET', '', { query: { uploads: '' } })).text();
        await Promise.all(
          Array.from(open.matchAll(/<Upload>(.*?)<\/Upload>/gsu), ([, upload = '']) => {
            // Each in its own match, as R2 lists the ID first and S3 the key.
            const key = /<Key>([^<]*)<\/Key>/u.exec(upload)?.[1] ?? '';
            const uploadId = /<UploadId>([^<]*)<\/UploadId>/u.exec(upload)?.[1] ?? '';
            return raw.send('DELETE', unescapeXml(key), {
              query: { uploadId: unescapeXml(uploadId) },
            });
          }),
        );
        await raw.send('DELETE', '');
      });
      if (isPublic && REAL_S3.hasBucketPolicies) {
        const policy = await raw.send('PUT', '', {
          query: { policy: '' },
          body: await readmeBucketPolicy(bucket),
        });
        if (!policy.ok) throw new Error(`The README's policy: ${await policy.text()}`);
      }
    }
    const env = () => ({
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
    });
    return { fake, realEndpoint, bucket, raw, env };
  };

  const dataKeyOf = ({ id, name }: { id: string; name: string }) => `artifacts/${id}/${name}`;

  const s3ErrorBody = (message: string) =>
    `<Error><Code>Refused</Code><Message>${message}</Message></Error>`;

  const startS3Target = async () => {
    const { fake, realEndpoint, bucket, raw, env } = await startBucket({ isPublic: true });
    const linkBase =
      REAL_S3?.hasBucketPolicies === false
        ? await startSigningProxy(raw)
        : `${realEndpoint}/${bucket}`;
    let endpoint = realEndpoint;
    /** The client itself, in this process, to store what a step will find. */
    const asJob = <A, E>(
      use: (
        target: Effect.Success<ReturnType<typeof makeS3Target>>,
      ) => Effect.Effect<A, E, FileSystem.FileSystem>,
      run: Partial<RunClaims>,
    ) => {
      const { repository, repository_id, run_id, run_attempt } = { ...CURRENT_RUN, ...run };
      return Effect.runPromise(
        makeS3Target({
          bucket,
          region: S3_REGION,
          endpoint: realEndpoint,
          linkBase,
          scope: '',
        }).pipe(
          Effect.flatMap(use),
          Effect.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              Layer.succeed(HttpClient.TracerPropagationEnabled, false),
              NodeFileSystem.layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  ...env(),
                  GITHUB_REPOSITORY: repository,
                  GITHUB_REPOSITORY_ID: repository_id,
                  GITHUB_RUN_ID: run_id,
                  GITHUB_RUN_ATTEMPT: run_attempt,
                }),
              ),
            ),
          ),
        ),
      );
    };
    const storeBytes = async (
      name: string,
      content: Uint8Array,
      run: Partial<RunClaims> = {},
    ): Promise<Stored> => {
      const path = join(rootDir, `stored-${crypto.randomUUID()}`);
      await writeFile(path, content);
      const { id, digest, links, expiresAt } = await asJob(
        target =>
          Effect.gen(function* () {
            const file = yield* openFileToSend(path);
            const sent = yield* target.send({ file, name, overwrite: false, retentionDays: 0 });
            return { ...sent, digest: file.digest };
          }),
        run,
      );
      await rm(path);
      return { id, name, digest, size: content.length, expiresAt, links: { ...links } };
    };
    return {
      kind: 's3' as const,
      bucket,
      linkBase,
      raw,
      fake,
      asJob,
      endpoint: () => endpoint,
      inputs: () => ({
        'INPUT_S3-BUCKET': bucket,
        'INPUT_S3-REGION': S3_REGION,
        'INPUT_S3-ENDPOINT': endpoint,
        'INPUT_S3-LINK-BASE': linkBase,
      }),
      flags: () => [
        '--s3-bucket',
        bucket,
        '--s3-region',
        S3_REGION,
        '--s3-endpoint',
        endpoint,
        '--s3-link-base',
        linkBase,
      ],
      env,
      store: storeBytes,
      storeFromDisk: async (name: string, path: string) => {
        await asJob(
          target =>
            openFileToSend(path).pipe(
              Effect.flatMap(file =>
                target.send({ file, name, overwrite: false, retentionDays: 0 }),
              ),
            ),
          {},
        );
      },
      list: (run: Partial<RunClaims> = {}): Promise<Stored[]> =>
        asJob(target => target.list({ repository: '', runId: '' }), run).then(listed =>
          listed.map(artifact => ({ ...artifact, links: { ...artifact.links } })),
        ),
      linkOf: (artifact: { id: string; name: string }) =>
        `${linkBase}/${encodeS3Path(dataKeyOf(artifact))}`,
      reachable: (link: string) => link,
      // With no permission to list, AWS won't say whether a key exists. MinIO and R2 do.
      goneLinkStatuses: [403, 404],
      replaceBytes: async (artifact: Stored, bytes: Uint8Array) => {
        const response = await raw.send('PUT', dataKeyOf(artifact), {
          body: new Uint8Array(bytes),
        });
        if (!response.ok) throw new Error(`Replacing ${artifact.name}: ${response.status}`);
      },
      readBytes: async (artifact: Stored) =>
        Buffer.from(await (await raw.send('GET', dataKeyOf(artifact))).arrayBuffer()),
      interpose: async (intercept: (request: IncomingMessage) => Interception) => {
        endpoint = await startProxy({
          origin: realEndpoint,
          intercept,
          answerBody: s3ErrorBody,
        });
      },
      removeProxy: () => {
        endpoint = realEndpoint;
      },
      isUpload: ({ method, url: path }: IncomingMessage) =>
        method === 'PUT' && path?.includes('/artifacts/') === true,
      // The name's key, which is what makes a delete happen.
      isDeleteOf:
        ({ name }: { name: string }) =>
        ({ method, url: path }: IncomingMessage) =>
          method === 'DELETE' &&
          path?.endsWith(`${createHash('sha256').update(name).digest('hex')}.json`) === true,
    };
  };

  /**
   * A server in front of a private bucket. A proxy sits in front of each, as the server signs the host
   * it's given and a store holds a request to that, so the proxy can't arrive later. Only a store that
   * checks the host against itself, as R2 does, goes without one.
   */
  const startServerS3Target = async ({ sessionToken }: { sessionToken?: string } = {}) => {
    const { fake, realEndpoint, bucket, raw, env } = await startBucket({ isPublic: false });
    let interceptBucket: (request: IncomingMessage) => Interception = () => undefined;
    const endpoint =
      REAL_S3?.hasBucketPolicies === false
        ? realEndpoint
        : await startProxy({
            origin: realEndpoint,
            intercept: request => interceptBucket(request),
            answerBody: s3ErrorBody,
          });
    const url = await startBucketServer(
      { kind: 's3', bucket, region: S3_REGION, endpoint },
      { ...env(), ...(sessionToken === undefined ? {} : { AWS_SESSION_TOKEN: sessionToken }) },
    );
    return {
      ...serverRoutes(url, intercept => {
        interceptBucket = intercept;
      }),
      kind: 'server-s3' as const,
      serverUrl: url,
      /** What the server signs with, to forge what it wouldn't sign. */
      signing: {
        host: new URL(endpoint).host,
        region: S3_REGION,
        credentials: {
          accessKeyId: env().AWS_ACCESS_KEY_ID,
          secretAccessKey: Redacted.make(env().AWS_SECRET_ACCESS_KEY),
        },
      },
      bucket,
      raw,
      fake,
      serverLog,
      replaceBytes: async (artifact: Stored, bytes: Uint8Array) => {
        const key = dataKeyOf(artifact);
        const head = await raw.send('HEAD', key);
        const scope = head.headers.get('x-amz-meta-run-scope') ?? '';
        const response = await raw.send('PUT', key, {
          headers: { 'x-amz-meta-run-scope': scope },
          body: new Uint8Array(bytes),
        });
        if (!response.ok) throw new Error(`Replacing ${artifact.name}: ${response.status}`);
      },
      readBytes: async (artifact: Stored) =>
        Buffer.from(await (await raw.send('GET', dataKeyOf(artifact))).arrayBuffer()),
      // The body goes to the bucket, past the server.
      isUpload: ({ method, url: path }: IncomingMessage) =>
        method === 'PUT' && path?.includes('/artifacts/') === true,
    };
  };

  return {
    rootDir,
    workDir,
    runnerTemp,
    outputPath,
    storeDir,
    runnerEnv,
    signToken,
    tokenRequests,
    startArtifactServer,
    startServerTarget,
    startS3Target,
    startServerS3Target,
    /** The target a suite runs against, by its kind. */
    startTarget: (kind: TargetKind) => {
      if (kind === 'server') return startServerTarget();
      return kind === 's3' ? startS3Target() : startServerS3Target();
    },
    /** Which run the next token is for. */
    actAs: (run: Partial<RunClaims>) => {
      claims = { ...CURRENT_RUN, ...run };
    },
    /** A server the test wrote takes the place of the real one. */
    useFakeServer: (server: Server) => {
      stopArtifactServer = () => closeServer(server);
      // Anything on the machine probing loopback ports asks for `/`, which no client does, and a
      // test counting requests must not count it.
      const handlers = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/') return void res.writeHead(404).end();
        for (const handler of handlers) handler.call(server, req, res);
        return undefined;
      });
      return listenOnLoopback(server);
    },
    /** Spawned as the runner does, so the in-process servers keep answering while it runs. */
    runNode: (node: string, args: readonly string[], env: Record<string, string | undefined>) =>
      new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
        execFile(
          node,
          [...args],
          { cwd: workDir, env: { ...runnerEnv, ...jobEnv(), ...env } },
          (error, stdout, stderr) => {
            resolve({ exitCode: exitCodeOf(error), stdout, stderr });
          },
        );
      }),
    readOutputs: async () =>
      Object.fromEntries(
        (await readFile(outputPath, 'utf8'))
          .trimEnd()
          .split('\n')
          .map(line => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      ),
    stop: async () => {
      await Promise.all(stops.map(stop => stop()));
      await stopArtifactServer();
      await closeServer(tokenServer);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
};

export const generateRunnerKeys = () => crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
