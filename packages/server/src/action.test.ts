import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config.ts';
import { createTokenVerifier, type TokenVerifier } from './oidc.ts';
import { createArtifactServer } from './server.ts';
import { createStore } from './store.ts';

const ACTION = new URL('../../../upload/upload.mjs', import.meta.url).pathname;
const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;
const AUDIENCE = 'custom-audience';
const REQUEST_TOKEN = 'runner-request-token';

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

const listenOnLoopback = async (server: Server): Promise<string> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const closeServer = async (server: Server) => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

describe('the upload action', () => {
  let keys: CryptoKeyPair;
  let rootDir: string;
  let artifactServer: Server;
  let tokenServer: Server;
  let serverUrl: string;
  let tokenRequestUrl: string;
  let outputPath: string;
  let tokenRequests: URL[];
  let tokenRequestAuth: (string | undefined)[];

  beforeAll(async () => {
    keys = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  });

  const signToken = async () => {
    const nowSeconds = Temporal.Now.instant().epochMilliseconds / 1000;
    const signed = `${encodeJson({ alg: 'RS256', kid: 'key-1' })}.${encodeJson({
      iss: 'https://token.actions.githubusercontent.com',
      aud: AUDIENCE,
      nbf: nowSeconds,
      exp: nowSeconds + 300,
      repository: 'fishballapp/private-thing',
      repository_owner_id: '42',
      repository_visibility: 'private',
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

  const startArtifactServer = async ({
    configOverrides = {},
    verifyToken,
  }: {
    configOverrides?: Partial<Config>;
    verifyToken?: TokenVerifier;
  } = {}) => {
    const storeDir = join(rootDir, 'store');
    await mkdir(storeDir, { recursive: true });
    const now = () => Temporal.Now.instant();
    const jwk = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid: 'key-1',
      use: 'sig',
      alg: 'RS256',
    };
    artifactServer = createArtifactServer({
      config: {
        storeDir,
        oidcAudience: AUDIENCE,
        oidcRepositoryOwnerId: '42',
        linkBases: { home: 'http://127.0.0.1:1', tailscale: 'https://files.example' },
        host: '127.0.0.1',
        port: 0,
        defaultRetentionDays: 7,
        maxRetentionDays: 30,
        minFreeBytes: 0,
        maxFileBytes: 1024 ** 3,
        ...configOverrides,
      },
      store: createStore({ dir: storeDir, now }),
      verifyToken:
        verifyToken ??
        createTokenVerifier({
          audience: AUDIENCE,
          repositoryOwnerId: '42',
          fetchJwks: async () => ({ keys: [jwk] }),
          now,
        }),
      log: () => undefined,
    });
    serverUrl = await listenOnLoopback(artifactServer);
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-action-'));
    outputPath = join(rootDir, 'github-output');
    tokenRequests = [];
    tokenRequestAuth = [];
    tokenServer = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      // Anything on the machine probing loopback ports lands here too, so count only the endpoint.
      if (url.pathname !== '/token') return void res.writeHead(404).end();
      tokenRequests.push(url);
      tokenRequestAuth.push(req.headers.authorization);
      void signToken().then(value => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value }));
      });
      return undefined;
    });
    tokenRequestUrl = `${await listenOnLoopback(tokenServer)}/token?api-version=2.0`;
  });

  afterEach(async () => {
    await closeServer(artifactServer);
    await closeServer(tokenServer);
    await rm(rootDir, { recursive: true, force: true });
  });

  /** Spawned as the runner does, so the in-process servers keep answering while it runs. */
  const runAction = (
    inputs: Record<string, string>,
    env: Record<string, string | undefined> = {},
  ) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
      execFile(
        process.execPath,
        [ACTION],
        {
          cwd: rootDir,
          env: {
            PATH: process.env.PATH,
            GITHUB_OUTPUT: outputPath,
            ACTIONS_ID_TOKEN_REQUEST_URL: tokenRequestUrl,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
            'INPUT_SERVER-URL': serverUrl,
            INPUT_AUDIENCE: AUDIENCE,
            ...inputs,
            ...env,
          },
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error === null ? 0 : Number(error.code),
            stdout,
            stderr,
          });
        },
      );
    });

  const readOutputs = async () =>
    Object.fromEntries(
      (await readFile(outputPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

  it('uploads a file that downloads back byte for byte', async () => {
    await startArtifactServer();
    const content = crypto.getRandomValues(new Uint8Array(65_536));
    const path = join(rootDir, 'liuk-preview.apk');
    await writeFile(path, content);

    const { exitCode, stdout } = await runAction({
      INPUT_PATH: path,
      'INPUT_RETENTION-DAYS': '2',
    });

    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);

    // The audience joins a query string the URL already has, with the runner's bearer token.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.searchParams.get('api-version')).toBe('2.0');
    expect(tokenRequests[0]?.searchParams.get('audience')).toBe(AUDIENCE);
    expect(tokenRequestAuth).toEqual([`Bearer ${REQUEST_TOKEN}`]);

    const outputs = await readOutputs();
    const links = JSON.parse(outputs.links ?? '') as Record<string, string>;
    expect(Object.keys(links)).toEqual(['home', 'tailscale']);
    expect(outputs['artifact-url']).toBe(links.home);
    expect(links.home).toMatch(/\/liuk-preview\.apk$/);
    const expiresAt = Temporal.Instant.from(outputs['expires-at'] ?? '');
    const untilExpiry = expiresAt.since(Temporal.Now.instant()).total('hours');
    expect(untilExpiry).toBeGreaterThan(47);
    expect(untilExpiry).toBeLessThanOrEqual(48);

    const { pathname } = new URL(links.home ?? '');
    const download = await fetch(`${serverUrl}${pathname}`);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);
  });

  it('streams the file rather than holding it in memory', { timeout: 30_000 }, async () => {
    await startArtifactServer();
    const fileBytes = 512 * 1024 ** 2;
    const path = join(rootDir, 'big.bin');
    await writeFile(path, '');
    await truncate(path, fileBytes);
    const reporter = join(rootDir, 'report-peak-memory.mjs');
    await writeFile(
      reporter,
      "process.on('exit', () => process.stderr.write('peak-kib=' + process.resourceUsage().maxRSS + '\\n'));",
    );

    const { exitCode, stderr } = await runAction(
      { INPUT_PATH: path },
      { NODE_OPTIONS: `--import=${reporter}` },
    );

    expect(exitCode).toBe(0);
    const peakBytes = Number(/peak-kib=(\d+)/.exec(stderr)?.[1]) * 1024;
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(fileBytes / 2);
  });

  it('uses the name input over the basename', async () => {
    await startArtifactServer();
    const path = join(rootDir, 'local.bin');
    await writeFile(path, 'x');
    const { exitCode } = await runAction({ INPUT_PATH: path, INPUT_NAME: 'renamed.bin' });
    expect(exitCode).toBe(0);
    expect((await readOutputs())['artifact-url']).toMatch(/\/renamed\.bin$/);
  });

  it('rejects a folder, saying folders are not supported', async () => {
    await startArtifactServer();
    const path = join(rootDir, 'a-folder');
    await mkdir(path);
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::.*folders are not supported in version 1/m);
    expect(tokenRequests).toEqual([]);
  });

  it('rejects a missing file', async () => {
    await startArtifactServer();
    const { exitCode, stdout } = await runAction({ INPUT_PATH: join(rootDir, 'nope.apk') });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::No file at /m);
  });

  it('asks for the id-token permission when the runner gave no token vars', async () => {
    await startArtifactServer();
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction(
      { INPUT_PATH: path },
      { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain('permissions: id-token: write');
  });

  it("fails on another 4xx with the server's message, without retrying", async () => {
    await startArtifactServer();
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path, INPUT_NAME: '.bad name' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::name must match/m);
    expect(tokenRequests).toHaveLength(1);
  });

  it('reads the 413 of a file much bigger than the limit', async () => {
    await startArtifactServer({ configOverrides: { maxFileBytes: 1024 } });
    const path = join(rootDir, 'big.bin');
    await writeFile(path, '');
    await truncate(path, 256 * 1024 * 1024);
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::File is over the limit of 1024 bytes/m);
    expect(tokenRequests).toHaveLength(1);
  });

  it('retries a 5xx, minting a fresh token per attempt', async () => {
    let attempts = 0;
    await startArtifactServer({
      verifyToken: async () => {
        attempts += 1;
        return attempts === 1
          ? { kind: 'unavailable', reason: 'could not fetch the JWKS' }
          : { kind: 'verified', repository: 'fishballapp/private-thing' };
      },
    });
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(stdout).toContain('Attempt 1 failed (GitHub signing keys are unavailable)');
    expect(exitCode).toBe(0);
    expect(tokenRequests).toHaveLength(2);
  });

  const startFakeServer = async (answers: { status: number; body: unknown }[]) => {
    const remaining = [...answers];
    artifactServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const { status, body } = remaining.shift() ?? { status: 500, body: {} };
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      });
    });
    serverUrl = await listenOnLoopback(artifactServer);
  };

  it.each([
    ['no links', { links: {}, expiresAt: '2030-01-01T00:00:00Z' }],
    ['no links object', { expiresAt: '2030-01-01T00:00:00Z' }],
    ['no expiry', { links: { home: 'http://x/a' } }],
    ['a line break in a link', { links: { home: 'http://x/a\nowned=1' }, expiresAt: 'x' }],
    [
      'a line break in another link',
      { links: { a: 'http://x/a', b: 'b\nowned=1' }, expiresAt: 'x' },
    ],
    ['a line break in the expiry', { links: { home: 'http://x/a' }, expiresAt: 'x\nowned=1' }],
  ])('refuses an answer with %s, writing no outputs', async (_, body) => {
    await startFakeServer([{ status: 201, body }]);
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::.* answered without a usable link/m);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it("keeps a server's message from starting a workflow command", async () => {
    await startFakeServer([
      { status: 500, body: { error: 'boom\n::warning::injected' } },
      { status: 201, body: { links: { home: 'http://x/a' }, expiresAt: 'x' } },
    ]);
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/^::warning::/m);
  });

  it('gives up on a network error after retrying, with the cause', {
    timeout: 20_000,
  }, async () => {
    await startArtifactServer();
    await closeServer(artifactServer);
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::fetch failed: .*ECONNREFUSED/m);
    expect(tokenRequests).toHaveLength(4);
  });
});
