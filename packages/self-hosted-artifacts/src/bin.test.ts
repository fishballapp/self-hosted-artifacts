import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const BIN = new URL('./bin.ts', import.meta.url).pathname;

const run = (args: string[]) => promisify(execFile)(process.execPath, [BIN, ...args]);

describe('self-hosted-artifacts', () => {
  it.each([
    [['serve'], 'Missing required flag: --config'],
    [['serve', '--nope'], 'Unrecognized flag: --nope'],
    [['serve', '--config'], '--config'],
    [['upload', '--path', 'a'], 'Give exactly one of server-url and s3-bucket'],
    [['download'], 'Give exactly one of server-url and s3-bucket'],
    [['list'], 'Give exactly one of server-url and s3-bucket'],
    [['delete'], 'Give exactly one of server-url and s3-bucket'],
    [['merge'], 'Give exactly one of server-url and s3-bucket'],
  ])('prints the error and fails for arguments %j', async (args, message) => {
    await expect(run(args)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(message),
    });
  });

  it('prints the usage for --help', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toContain('serve');
    for (const command of ['upload', 'download', 'list', 'delete']) {
      expect(stdout).toContain(command);
    }
    expect((await run(['serve', '--help'])).stdout).toContain('--config string');
  });

  it('prints the package version for --version', async () => {
    const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const { stdout } = await run(['--version']);
    expect(stdout).toContain(JSON.parse(packageJson).version);
  });

  it('fails at startup with a clear message when the config is bad', async () => {
    await expect(run(['serve', '--config', '/nonexistent/config.json'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Can't read the config file /nonexistent/config.json: ENOENT",
      ),
    });
  });

  it('says outside a GitHub Actions job that the server takes no upload from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bin-'));
    const path = join(dir, 'a.bin');
    await writeFile(path, 'x');
    try {
      await expect(
        promisify(execFile)(
          process.execPath,
          [BIN, 'upload', '--server-url', 'http://127.0.0.1:1', '--path', path],
          { env: { PATH: process.env.PATH } },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('No OIDC token available'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const withRunningServer = async (
    use: (running: { child: ChildProcess; port: number }) => Promise<void>,
    { seedStore }: { seedStore?: (dir: string) => Promise<void> } = {},
  ) => {
    const dir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bin-'));
    // Before the server starts, as its first sweep removes a directory with no metadata yet.
    await seedStore?.(dir);
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        store: { kind: 'disk', dir },
        oidcAudience: 'self-hosted-artifacts',
        oidcRepositoryOwnerId: 42,
        linkBases: { home: 'http://192.0.2.1:8420' },
        host: '127.0.0.1',
        port: 0,
      }),
    );
    const child = spawn(process.execPath, [BIN, 'serve', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
      // A test that times out never reaches its cleanup, and a live child would hang the run.
      timeout: 25_000,
      killSignal: 'SIGKILL',
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        child.once('exit', code => reject(new Error(`bin exited with ${code}`)));
        child.stdout.setEncoding('utf8').on('data', (text: string) => {
          const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
          if (match?.[1] !== undefined) resolve(match[1]);
        });
      });
      child.removeAllListeners('exit');
      await use({ child, port: Number(port) });
    } finally {
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  };

  describe('with a bucket as the store', () => {
    /** The config file, against an endpoint nothing answers: startup must not need the bucket. */
    const writeBucketConfig = async (dir: string) => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          store: { kind: 's3', bucket: 'builds', region: 'auto', endpoint: 'http://127.0.0.1:1' },
          oidcAudience: 'self-hosted-artifacts',
          oidcRepositoryOwnerId: 42,
          linkBases: { home: 'http://192.0.2.1:8420' },
          host: '127.0.0.1',
          port: 0,
        }),
      );
      return configPath;
    };

    it.each<[string, Record<string, string>]>([
      ['neither key', {}],
      ['no secret', { AWS_ACCESS_KEY_ID: 'visible-only-if-printed' }],
      ['no key ID', { AWS_SECRET_ACCESS_KEY: 'visible-only-if-printed' }],
      [
        'an empty secret',
        { AWS_ACCESS_KEY_ID: 'visible-only-if-printed', AWS_SECRET_ACCESS_KEY: '' },
      ],
    ])('stops at startup with %s, naming the variables and no value', async (_, env) => {
      const dir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bin-'));
      try {
        const failure = await promisify(execFile)(
          process.execPath,
          [BIN, 'serve', '--config', await writeBucketConfig(dir)],
          { env: { PATH: process.env.PATH, ...env } },
        ).then(
          () => undefined,
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
        expect(failure?.code).toBe(1);
        expect(failure?.stderr).toContain('No S3 credentials');
        expect(failure?.stderr).toContain('AWS_ACCESS_KEY_ID');
        expect(failure?.stderr).toContain('AWS_SECRET_ACCESS_KEY');
        expect(`${failure?.stdout}${failure?.stderr}`).not.toContain('visible-only-if-printed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('starts without asking the bucket anything, and has no sweep', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-bin-'));
      const child = spawn(
        process.execPath,
        [BIN, 'serve', '--config', await writeBucketConfig(dir)],
        {
          stdio: ['ignore', 'pipe', 'inherit'],
          env: {
            PATH: process.env.PATH,
            AWS_ACCESS_KEY_ID: 'a',
            AWS_SECRET_ACCESS_KEY: 'b',
          },
          timeout: 25_000,
          killSignal: 'SIGKILL',
        },
      );
      try {
        const logged: string[] = [];
        const port = await new Promise<string>((resolve, reject) => {
          child.once('exit', code => reject(new Error(`bin exited with ${code}`)));
          child.stdout.setEncoding('utf8').on('data', (text: string) => {
            logged.push(text);
            const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
            if (match?.[1] !== undefined) resolve(match[1]);
          });
        });
        child.removeAllListeners('exit');
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        expect(logged.join('')).not.toContain('sweep');
      } finally {
        child.removeAllListeners('exit');
        child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('runs from a config file and answers /healthz', () =>
    withRunningServer(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(200);
    }));

  it("stops well inside launchd's 20 seconds with a download stalled", {
    timeout: 25_000,
  }, () => {
    const token = 'a'.repeat(43);
    return withRunningServer(
      async ({ child, port }) => {
        const socket = connect(port, '127.0.0.1');
        socket.on('error', () => undefined);
        socket.write(`GET /${token}/a HTTP/1.1\r\nHost: x\r\n\r\n`);
        const [firstChunk] = await once(socket, 'data');
        socket.pause();
        expect(String(firstChunk)).toMatch(/^HTTP\/1\.1 200/);

        const startedAt = performance.now();
        child.kill('SIGTERM');
        await once(child, 'exit');
        socket.destroy();

        expect(performance.now() - startedAt).toBeLessThan(10_000);
      },
      {
        seedStore: async dir => {
          const artifact = join(dir, 'artifacts', token);
          await mkdir(artifact, { recursive: true });
          const size = 2 ** 30;
          await writeFile(join(artifact, 'data'), '');
          await truncate(join(artifact, 'data'), size);
          const expiresAt = Temporal.Now.instant().add({ hours: 1 }).toString();
          await writeFile(
            join(artifact, 'meta.json'),
            JSON.stringify({
              id: token,
              repositoryId: '7',
              runId: '100',
              runAttempt: '1',
              name: 'a',
              size,
              digest: 'unchecked',
              expiresAt,
            }),
          );
          const names = join(dir, 'runs', '7', '100', '1');
          await mkdir(names, { recursive: true });
          const nameHash = createHash('sha256').update('a').digest('hex');
          await link(join(artifact, 'meta.json'), join(names, `${nameHash}.json`));
        },
      },
    );
  });
});
