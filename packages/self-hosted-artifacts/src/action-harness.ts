import { type ExecFileException, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { build, type UserConfig } from 'tsdown';
import { type Config, ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { makeS3Target } from './s3-client.ts';
import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, rawS3Client, startFakeS3 } from './s3-fake.ts';
import { closeServer, listenOnLoopback, startTestServer } from './test-support.ts';

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
 * Builds an action into a folder of its own, and answers with the file. Test files run in parallel, and
 * a build empties its folder first, so sharing one would pull a bundle out from under another file's step.
 */
export const buildBundle = async (config: UserConfig) => {
  const outDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bundle-'));
  await build({
    ...config,
    outDir,
    config: false,
    cwd: new URL('..', import.meta.url).pathname,
    logLevel: 'silent',
  });
  return join(outDir, 'action.mjs');
};

export const removeBundle = (bundle: string) =>
  rm(dirname(bundle), { recursive: true, force: true });

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

/** Both targets run through the same scenarios wherever they should behave the same. */
export const TARGET_KINDS = ['server', 's3'] as const;
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
 * bucket, with the README's own policy on it.
 */
const REAL_S3 =
  process.env.S3_TEST_ENDPOINT === undefined
    ? undefined
    : {
        endpoint: process.env.S3_TEST_ENDPOINT,
        accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
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

  const startArtifactServer = async (
    overrides: Partial<Config> = {},
    verifier?: Layer.Layer<TokenVerifier>,
  ) => {
    const config = {
      storeDir,
      oidcAudience: AUDIENCE,
      oidcRepositoryOwnerId: '42',
      // A runner can't reach these, so a client that fetched by link would fail.
      linkBases: { home: 'http://127.0.0.1:1', tailscale: 'https://files.example' },
      host: '127.0.0.1',
      port: 0,
      defaultRetentionDays: 7,
      maxRetentionDays: 30,
      minFreeBytes: 0,
      maxFileBytes: 1024 ** 3,
      ...overrides,
    };
    const testServer = await startTestServer({
      config,
      verifier:
        verifier ??
        TokenVerifier.layer.pipe(
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, async () => Response.json({ keys: [jwk] })),
          ),
        ),
    });
    stopArtifactServer = testServer.stop;
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
          if (interception === 'lose-answer') {
            answer.resume();
            answer.on('end', () => res.destroy());
            return;
          }
          res.writeHead(answer.statusCode ?? 500, answer.headers);
          answer.pipe(res);
        },
      );
      req.pipe(forward);
      return undefined;
    });
    stops.push(() => closeServer(proxy));
    return listenOnLoopback(proxy);
  };

  const startServerTarget = async (
    overrides: Partial<Config> = {},
    verifier?: Layer.Layer<TokenVerifier>,
  ) => {
    let url = await startArtifactServer(overrides, verifier);
    const realUrl = url;
    const authorized = async () => ({ Authorization: `Bearer ${await signToken()}` });
    const post = async (name: string, body: BodyInit, run: Partial<RunClaims>) => {
      claims = { ...CURRENT_RUN, ...run };
      const response = await fetch(`${url}/artifacts?name=${name}`, {
        method: 'POST',
        headers: await authorized(),
        body,
      });
      claims = CURRENT_RUN;
      if (response.status !== 201) throw new Error(`Storing ${name}: ${response.status}`);
      return (await response.json()) as Stored;
    };
    return {
      kind: 'server' as const,
      inputs: () => ({ 'INPUT_SERVER-URL': url, INPUT_AUDIENCE: AUDIENCE }),
      flags: () => ['--server-url', url, '--audience', AUDIENCE],
      env: () => ({}),
      /** Straight to the real server, as the job that uploaded would, with a real token. */
      store: (name: string, content: Uint8Array, run: Partial<RunClaims> = {}) =>
        post(name, new Uint8Array(content), run),
      /** Sent from disk, as the real upload is: the test's own memory stays out of it. */
      storeFromDisk: async (name: string, path: string) => post(name, await openAsBlob(path), {}),
      /** What the run holds, latest attempt of each name. */
      list: async (run: Partial<RunClaims> = {}) => {
        claims = { ...CURRENT_RUN, ...run };
        const response = await fetch(`${url}/artifacts`, { headers: await authorized() });
        claims = CURRENT_RUN;
        return ((await response.json()) as { artifacts: Stored[] }).artifacts;
      },
      linkOf: ({ id, name }: { id: string; name: string }) => `${realUrl}/${id}/${name}`,
      /** A link from an output: its base is one a runner can't reach, so the path goes to the server. */
      reachable: (link: string) => `${realUrl}${new URL(link).pathname}`,
      goneLinkStatuses: [404],
      /** Replaces what's stored behind its digest's back. */
      replaceBytes: ({ id }: Stored, bytes: Uint8Array) =>
        writeFile(join(storeDir, 'artifacts', id, 'data'), bytes),
      readBytes: ({ id }: Stored) => readFile(join(storeDir, 'artifacts', id, 'data')),
      /** From here on, a step goes through a proxy. */
      interpose: async (intercept: (request: IncomingMessage) => Interception) => {
        url = await startProxy({
          origin: realUrl,
          intercept,
          answerBody: message => JSON.stringify({ error: message }),
        });
      },
      removeProxy: () => {
        url = realUrl;
      },
      isUpload: ({ method, url: path }: IncomingMessage) =>
        method === 'POST' && path?.startsWith('/artifacts') === true,
      isDeleteOf:
        ({ id }: { id: string }) =>
        ({ method, url: path }: IncomingMessage) =>
          method === 'DELETE' && path?.endsWith(id) === true,
    };
  };

  const startS3Target = async () => {
    const fake = REAL_S3 === undefined ? await startFakeS3() : undefined;
    if (fake !== undefined) stops.push(fake.stop);
    const realEndpoint = REAL_S3?.endpoint ?? fake?.endpoint ?? '';
    const accessKeyId = REAL_S3?.accessKeyId ?? FAKE_ACCESS_KEY_ID;
    const secretAccessKey = REAL_S3?.secretAccessKey ?? FAKE_SECRET_ACCESS_KEY;
    const bucket = `test-${crypto.randomUUID()}`;
    const linkBase = `${realEndpoint}/${bucket}`;
    const raw = rawS3Client({
      endpoint: realEndpoint,
      bucket,
      credentials: { accessKeyId, secretAccessKey: Redacted.make(secretAccessKey) },
      region: S3_REGION,
    });
    if (REAL_S3 !== undefined) {
      const created = await raw.send('PUT', '');
      if (!created.ok) throw new Error(`Creating ${bucket}: ${await created.text()}`);
      const policy = await raw.send('PUT', '', {
        query: { policy: '' },
        body: await readmeBucketPolicy(bucket),
      });
      if (!policy.ok) throw new Error(`The README's policy: ${await policy.text()}`);
    }
    let endpoint = realEndpoint;
    const env = () => ({
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
    });
    /** The client itself, in this process, to store what a step will find. */
    const asJob = <A, E>(
      use: (target: Effect.Success<ReturnType<typeof makeS3Target>>) => Effect.Effect<A, E>,
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
      const digest = createHash('sha256').update(content).digest('hex');
      const { id, links, expiresAt } = await asJob(
        target =>
          target.send({
            file: new Blob([new Uint8Array(content)]),
            name,
            digest,
            overwrite: false,
            retentionDays: 0,
          }),
        run,
      );
      return { id, name, digest, size: content.length, expiresAt, links: { ...links } };
    };
    const dataKeyOf = ({ id, name }: { id: string; name: string }) => `artifacts/${id}/${name}`;
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
        const file = await openAsBlob(path);
        const digest = createHash('sha256');
        for await (const chunk of file.stream()) digest.update(chunk);
        const hex = digest.digest('hex');
        await asJob(
          target => target.send({ file, name, digest: hex, overwrite: false, retentionDays: 0 }),
          {},
        );
      },
      list: (run: Partial<RunClaims> = {}): Promise<Stored[]> =>
        asJob(target => target.list({ repository: '', runId: '' }), run).then(listed =>
          listed.map(artifact => ({ ...artifact, links: { ...artifact.links } })),
        ),
      linkOf: (artifact: { id: string; name: string }) => `${linkBase}/${dataKeyOf(artifact)}`,
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
          answerBody: message => `<Error><Code>Refused</Code><Message>${message}</Message></Error>`,
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
    /** The target a suite runs against, by its kind. */
    startTarget: (kind: TargetKind) => (kind === 'server' ? startServerTarget() : startS3Target()),
    /** Which run the next token is for. */
    actAs: (run: Partial<RunClaims>) => {
      claims = { ...CURRENT_RUN, ...run };
    },
    /** A server the test wrote takes the place of the real one. */
    useFakeServer: (server: Server) => {
      stopArtifactServer = () => closeServer(server);
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
