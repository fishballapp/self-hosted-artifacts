import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { build, type UserConfig } from 'tsdown';
import { type Config, ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { startTestServer } from './test-support.ts';

/**
 * One bundle rather than the whole package, as test files run side by side and a build cleans its
 * output folder: each file builds only the action it runs.
 */
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

export const buildBundle = (config: UserConfig) =>
  build({
    ...config,
    config: false,
    cwd: new URL('..', import.meta.url).pathname,
    logLevel: 'silent',
  });

export const AUDIENCE = 'custom-audience';
const REQUEST_TOKEN = 'runner-request-token';
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

export const listenOnLoopback = async (server: Server): Promise<string> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

export const closeServer = async (server: Server) => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

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
 * Everything around a step on a runner, for one test: its directories, the runner's token endpoint
 * signing real tokens for whichever run the test says this is, and a real server that checks them.
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

  const startArtifactServer = async (overrides: Partial<Config> = {}) => {
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
      verifier: TokenVerifier.layer.pipe(
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

  return {
    rootDir,
    workDir,
    runnerTemp,
    outputPath,
    storeDir,
    runnerEnv,
    signToken,
    startArtifactServer,
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
          { cwd: workDir, env: { ...runnerEnv, ...env } },
          (error, stdout, stderr) => {
            resolve({ exitCode: error === null ? 0 : Number(error.code), stdout, stderr });
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
      await stopArtifactServer();
      await closeServer(tokenServer);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
};

export const generateRunnerKeys = () => crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
