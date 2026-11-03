import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_ACTION } from '../tsdown.config.ts';
import {
  AUDIENCE,
  buildBundle,
  exitCodeOf,
  generateRunnerKeys,
  PEAK_REPORTER,
  REQUEST_TOKEN,
  removeBundle,
  startRunner,
  TARGET_KINDS,
} from './action-harness.ts';
import { closeServer, listenOnLoopback, verifierAnswering } from './test-support.ts';

let ACTION: string;
// CI sets this to a Node 24 binary, as that is what the runner runs the action on.
const ACTION_NODE = process.env.ACTION_NODE ?? process.execPath;

describe.each(TARGET_KINDS)('the upload action, against %s', kind => {
  let keys: CryptoKeyPair;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  let target: Awaited<ReturnType<typeof runner.startTarget>> | undefined;
  let serverUrl: string;
  let rootDir: string;
  let outputPath: string;
  let workDir: string;
  let runnerTemp: string;

  beforeAll(async () => {
    ACTION = await buildBundle(UPLOAD_ACTION);
    keys = await generateRunnerKeys();
  }, 60_000);

  afterAll(() => removeBundle(ACTION));

  beforeEach(async () => {
    runner = await startRunner({ keys });
    target = undefined;
    serverUrl = '';
    ({ rootDir, outputPath, workDir, runnerTemp } = runner);
  });

  afterEach(async () => {
    await runner.stop();
  });

  const startTarget = async () => {
    target = await runner.startTarget(kind);
    return target;
  };

  const requireTarget = () => {
    if (target === undefined) throw new Error('No target started');
    return target;
  };

  /** A server a test wrote, in place of the real target. */
  const useFakeServer = async (server: Server) => {
    serverUrl = await runner.useFakeServer(server);
  };

  /** Only a server has tokens to count. */
  const expectTokenRequests = (count: number) => {
    if (kind === 'server') expect(runner.tokenRequests).toHaveLength(count);
  };

  /** Spawned as the runner does, so the in-process servers keep answering while it runs. */
  const runAction = (
    inputs: Record<string, string>,
    env: Record<string, string | undefined> = {},
  ) =>
    runner.runNode(ACTION_NODE, [ACTION], {
      ...(target === undefined
        ? { 'INPUT_SERVER-URL': serverUrl, INPUT_AUDIENCE: AUDIENCE }
        : { ...target.inputs(), ...target.env() }),
      ...inputs,
      ...env,
    });

  const readOutputs = () => runner.readOutputs();

  const writeFiles = async (files: Record<string, string | Uint8Array>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(workDir, path)), { recursive: true });
      await writeFile(join(workDir, path), content);
    }
  };

  const downloadOutput = async (artifactUrl: string | undefined) => {
    const download = await fetch(requireTarget().reachable(artifactUrl ?? ''));
    expect(download.status).toBe(200);
    return new Uint8Array(await download.arrayBuffer());
  };

  /** Fetches the upload's link and unpacks it, with a zip reader other than the one that wrote it. */
  const downloadUnzipped = async () => {
    const zip = await downloadOutput((await readOutputs())['artifact-url']);
    return Object.fromEntries(
      Object.entries(unzipSync(zip)).map(([path, bytes]) => [
        path,
        Buffer.from(bytes).toString('base64'),
      ]),
    );
  };

  const base64 = (text: string) => Buffer.from(text).toString('base64');

  it('uploads a file that downloads back byte for byte', async () => {
    await startTarget();
    const content = crypto.getRandomValues(new Uint8Array(65_536));
    const path = join(rootDir, 'liuk-preview.apk');
    await writeFile(path, content);

    const { exitCode, stdout } = await runAction({
      INPUT_PATH: path,
      INPUT_ARCHIVE: 'false',
      'INPUT_RETENTION-DAYS': '2',
    });

    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);

    if (kind === 'server') {
      // The audience joins a query string the URL already has, with the runner's bearer token.
      expect(runner.tokenRequests).toHaveLength(1);
      expect(runner.tokenRequests[0]?.url.searchParams.get('api-version')).toBe('2.0');
      expect(runner.tokenRequests[0]?.url.searchParams.get('audience')).toBe(AUDIENCE);
      expect(runner.tokenRequests[0]?.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
    }

    const outputs = await readOutputs();
    const links = JSON.parse(outputs.links ?? '') as Record<string, string>;
    expect(Object.keys(links)).toEqual(kind === 'server' ? ['home', 'tailscale'] : ['s3']);
    const [firstLink = ''] = Object.values(links);
    expect(outputs['artifact-url']).toBe(firstLink);
    expect(firstLink).toMatch(/\/liuk-preview\.apk$/);
    expect(outputs['artifact-id']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstLink).toContain(`/${outputs['artifact-id']}/`);
    expect(outputs['artifact-digest']).toBe(createHash('sha256').update(content).digest('hex'));
    const expiresAt = Temporal.Instant.from(outputs['expires-at'] ?? '');
    const untilExpiry = expiresAt.since(Temporal.Now.instant()).total('hours');
    expect(untilExpiry).toBeGreaterThan(47);
    expect(untilExpiry).toBeLessThanOrEqual(48);

    expect(await downloadOutput(firstLink)).toEqual(content);
  });

  // Level 0 makes the zip as big as the file, so neither writing it nor uploading it can hide.
  it.each<[string, Record<string, string>]>([
    ['a file as it is', { INPUT_ARCHIVE: 'false' }],
    ['a zip as big as the file', { 'INPUT_COMPRESSION-LEVEL': '0' }],
    ['a compressed zip', {}],
  ])('holds %s out of memory', { timeout: 60_000 }, async (_, inputs) => {
    await startTarget();
    const fileBytes = 512 * 1024 ** 2;
    const path = join(rootDir, 'big.bin');
    await writeFile(path, '');
    await truncate(path, fileBytes);
    const reporter = join(rootDir, 'report-peak-memory.mjs');
    await writeFile(reporter, PEAK_REPORTER);

    const { exitCode, stderr } = await runAction(
      { INPUT_PATH: path, ...inputs },
      { NODE_OPTIONS: `--import=${reporter}` },
    );

    expect(exitCode).toBe(0);
    const peakBytes = Number(/peak-kib=(\d+)/.exec(stderr)?.[1]) * 1024;
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThan(fileBytes / 2);
  });

  const runCli = (args: readonly string[]) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
      execFile(
        process.execPath,
        [
          new URL('./bin.ts', import.meta.url).pathname,
          'upload',
          ...requireTarget().flags(),
          ...args,
        ],
        {
          cwd: workDir,
          env: {
            ...runner.runnerEnv,
            GITHUB_OUTPUT: undefined,
            GITHUB_REPOSITORY: 'fishballapp/private-thing',
            GITHUB_REPOSITORY_ID: '7',
            GITHUB_RUN_ID: '100',
            GITHUB_RUN_ATTEMPT: '1',
            ...requireTarget().env(),
          },
        },
        (error, stdout, stderr) => {
          resolve({ exitCode: exitCodeOf(error), stdout, stderr });
        },
      );
    });

  const firstLinkOf = (links: Record<string, string>) => Object.values(links)[0] ?? '';

  it('uploads through the CLI too, printing the result as JSON', async () => {
    await startTarget();
    await writeFiles({ 'dist/a.txt': 'a', 'dist/b.txt': 'b', 'dist/skip.map': 'c' });
    const { exitCode, stdout } = await runCli([
      '--path',
      'dist',
      '--path',
      '!dist/*.map',
      '--name',
      'from-cli',
    ]);
    expect(exitCode).toBe(0);
    const { id, name, digest, links } = JSON.parse(stdout);
    expect(name).toBe('from-cli.zip');
    expect(firstLinkOf(links)).toContain(`/${id}/`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(outputPath, `artifact-url=${firstLinkOf(links)}\n`);
    expect(await downloadUnzipped()).toEqual({ 'a.txt': base64('a'), 'b.txt': base64('b') });
  });

  it('takes the same flags as the inputs on the CLI', async () => {
    await startTarget();
    await writeFiles({ 'one.bin': 'x' });
    const { stdout } = await runCli([
      '--path',
      'one.bin',
      '--archive',
      'false',
      '--retention-days',
      '0',
    ]);
    const printed = JSON.parse(stdout);
    expect(printed).toMatchObject({ name: 'one.bin', size: 1 });
    expect(firstLinkOf(printed.links)).toMatch(/\/one\.bin$/);
  });

  it.each([
    ['warn', 0, 'Warning: No files were found'],
    ['ignore', 0, 'No files were found'],
    ['error', 1, 'No files were found'],
  ])(
    'with nothing found on the CLI and %s, exits %i, saying so on stderr',
    async (behaviour, code, message) => {
      await startTarget();
      const { exitCode, stdout, stderr } = await runCli([
        '--path',
        'nope',
        '--if-no-files-found',
        behaviour,
      ]);
      expect(exitCode).toBe(code);
      expect(stdout).toBe('');
      expect(stderr).toContain(message);
    },
  );

  it('overwrites through the CLI too', async () => {
    await startTarget();
    await writeFiles({ 'one.bin': 'first' });
    const flags = ['--path', 'one.bin', '--archive', 'false'];
    const first = JSON.parse((await runCli(flags)).stdout);
    await writeFiles({ 'one.bin': 'second' });

    const refused = await runCli(flags);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('already exists on the workflow run');

    const second = JSON.parse((await runCli([...flags, '--overwrite', 'true'])).stdout);
    expect(second.id).not.toBe(first.id);
    expect(second.digest).toBe(createHash('sha256').update('second').digest('hex'));
    expect(requireTarget().goneLinkStatuses).toContain(
      (await fetch(requireTarget().reachable(firstLinkOf(first.links)))).status,
    );
  });

  it('zips a folder by default, and it unpacks back byte for byte', async () => {
    await startTarget();
    const binary = crypto.getRandomValues(new Uint8Array(65_536));
    await writeFiles({
      'dist/app.bin': binary,
      'dist/empty.txt': '',
      'dist/nested/deeper/note.txt': 'héllo',
    });

    const { exitCode, stdout, stderr } = await runAction({ INPUT_PATH: 'dist' });

    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);
    expect(stderr).toContain('With the provided path, there will be 3 files uploaded');
    expect((await readOutputs())['artifact-url']).toMatch(/\/artifact\.zip$/);
    expect(await downloadUnzipped()).toEqual({
      'app.bin': Buffer.from(binary).toString('base64'),
      'empty.txt': '',
      'nested/deeper/note.txt': base64('héllo'),
    });
  });

  it('stores a zip as `<name>.zip`', async () => {
    await startTarget();
    await writeFiles({ 'a.txt': 'a' });
    const { exitCode } = await runAction({ INPUT_PATH: 'a.txt', INPUT_NAME: 'renamed' });
    expect(exitCode).toBe(0);
    expect((await readOutputs())['artifact-url']).toMatch(/\/renamed\.zip$/);
    // A lone file's folder is the root, so it sits at the top of the zip.
    expect(await downloadUnzipped()).toEqual({ 'a.txt': base64('a') });
  });

  it('keeps the path after the first wildcard', async () => {
    await startTarget();
    await writeFiles({
      'out/x/one.txt': '1',
      'out/y/two.txt': '2',
      'out/y/skip.log': 'no',
    });
    const { exitCode } = await runAction({ INPUT_PATH: 'out/**/*.txt' });
    expect(exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({
      'x/one.txt': base64('1'),
      'y/two.txt': base64('2'),
    });
  });

  it('roots several lines at their nearest common ancestor, and excludes with `!`', async () => {
    await startTarget();
    await writeFiles({
      'build/a/keep.txt': 'a',
      'build/a/drop.tmp': 'no',
      'build/b/keep.txt': 'b',
      'build/c/other.txt': 'no',
    });
    const { exitCode } = await runAction({
      INPUT_PATH: `
        build/a
        ./build/b/keep.txt
        !build/**/*.tmp
      `,
    });
    expect(exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({
      'a/keep.txt': base64('a'),
      'b/keep.txt': base64('b'),
    });
  });

  it('expands `~`, and reads an absolute path', async () => {
    await startTarget();
    await writeFiles({ 'home/in-home.txt': 'h' });
    const { exitCode } = await runAction(
      { INPUT_PATH: '~/in-home.txt' },
      { HOME: join(workDir, 'home') },
    );
    expect(exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({ 'in-home.txt': base64('h') });

    await rm(outputPath);
    const absolute = await runAction({ INPUT_PATH: join(workDir, 'home') });
    expect(absolute.exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({ 'in-home.txt': base64('h') });
  });

  it('leaves hidden files out unless asked', async () => {
    await startTarget();
    await writeFiles({
      'site/index.html': 'i',
      'site/.env': 'secret',
      'site/.cache/data': 'c',
      'site/sub/.hidden': 'h',
    });

    expect((await runAction({ INPUT_PATH: 'site' })).exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({ 'index.html': base64('i') });

    await rm(outputPath);
    expect(
      (
        await runAction({
          INPUT_PATH: 'site',
          'INPUT_INCLUDE-HIDDEN-FILES': 'true',
          INPUT_OVERWRITE: 'true',
        })
      ).exitCode,
    ).toBe(0);
    expect(await downloadUnzipped()).toEqual({
      'index.html': base64('i'),
      '.env': base64('secret'),
      '.cache/data': base64('c'),
      'sub/.hidden': base64('h'),
    });
  });

  it('warns by default when nothing is found, succeeding with no outputs', async () => {
    await startTarget();
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'nope/*' });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      '::warning::No files were found with the provided path: nope/*. No artifacts will be uploaded.',
    );
    expect(runner.tokenRequests).toEqual([]);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('treats a folder of only hidden files as nothing found', async () => {
    await startTarget();
    await writeFiles({ 'dot/.only': 'x' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'dot' });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('::warning::No files were found');
  });

  it('fails when nothing is found and if-no-files-found is error', async () => {
    await startTarget();
    const { exitCode, stdout } = await runAction({
      INPUT_PATH: 'nope',
      'INPUT_IF-NO-FILES-FOUND': 'error',
    });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::No files were found with the provided path: nope\./m);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('only says so when nothing is found and if-no-files-found is ignore', async () => {
    await startTarget();
    const { exitCode, stdout } = await runAction({
      INPUT_PATH: 'nope',
      'INPUT_IF-NO-FILES-FOUND': 'ignore',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No files were found with the provided path: nope.');
    expect(stdout).not.toContain('::');
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('with archive false, uploads the file as it is under its own name, ignoring name', async () => {
    await startTarget();
    await writeFiles({ 'out/app.apk': 'raw bytes' });
    const { exitCode } = await runAction({
      INPUT_PATH: 'out/*.apk',
      INPUT_NAME: 'ignored',
      INPUT_ARCHIVE: 'false',
    });
    expect(exitCode).toBe(0);
    const url = (await readOutputs())['artifact-url'];
    expect(url).toMatch(/\/app\.apk$/);
    expect(Buffer.from(await downloadOutput(url)).toString()).toBe('raw bytes');
  });

  it('with archive false, refuses more than one file', async () => {
    await startTarget();
    await writeFiles({ 'out/a': 'a', 'out/b': 'b' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'out', INPUT_ARCHIVE: 'false' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(
      /^::error::When 'archive' is set to false, only a single file can be uploaded\. Found 2 files to upload\./m,
    );
    expect(runner.tokenRequests).toEqual([]);
  });

  it("with archive false, fails with the server's message on a hidden file's name", async () => {
    await startTarget();
    await writeFiles({ '.env': 'x' });
    const { exitCode, stdout } = await runAction({
      INPUT_PATH: '.env',
      INPUT_ARCHIVE: 'false',
      'INPUT_INCLUDE-HIDDEN-FILES': 'true',
    });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::name must match/m);
  });

  it('compresses at the level asked for', async () => {
    await startTarget();
    await writeFiles({ 'text.txt': 'compress me '.repeat(10_000) });
    const sizes: Record<string, number> = {};
    for (const level of ['0', '1', '9']) {
      await rm(outputPath, { force: true });
      const { exitCode } = await runAction({
        INPUT_PATH: 'text.txt',
        INPUT_NAME: `level-${level}`,
        'INPUT_COMPRESSION-LEVEL': level,
      });
      expect(exitCode).toBe(0);
      sizes[level] = (await downloadOutput((await readOutputs())['artifact-url'])).length;
      expect(await downloadUnzipped()).toEqual({
        'text.txt': base64('compress me '.repeat(10_000)),
      });
    }
    expect(sizes['0']).toBeGreaterThan(120_000);
    expect(sizes['1']).toBeLessThan(sizes['0'] ?? 0);
    expect(sizes['9']).toBeLessThanOrEqual(sizes['1'] ?? 0);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'a compression level out of range',
      { 'INPUT_COMPRESSION-LEVEL': '10' },
      'Invalid compression-level. Valid values are 0-9',
    ],
    [
      'a compression level below range',
      { 'INPUT_COMPRESSION-LEVEL': '-1' },
      'Invalid compression-level. Valid values are 0-9',
    ],
    [
      'a compression level that is no number',
      { 'INPUT_COMPRESSION-LEVEL': 'max' },
      'Invalid compression-level',
    ],
    ['retention that is no number', { 'INPUT_RETENTION-DAYS': 'soon' }, 'Invalid retention-days'],
    [
      'an unknown if-no-files-found',
      { 'INPUT_IF-NO-FILES-FOUND': 'shout' },
      'Unrecognized if-no-files-found input. Provided: shout. Available options: warn,error,ignore',
    ],
    [
      'an archive that is no boolean',
      { INPUT_ARCHIVE: 'yes' },
      'Input does not meet YAML 1.2 "Core Schema" specification: archive',
    ],
    [
      'an include-hidden-files that is no boolean',
      { 'INPUT_INCLUDE-HIDDEN-FILES': '1' },
      'Input does not meet YAML 1.2 "Core Schema" specification: include-hidden-files',
    ],
    [
      'an overwrite that is no boolean',
      { INPUT_OVERWRITE: 'yes' },
      'Input does not meet YAML 1.2 "Core Schema" specification: overwrite',
    ],
    [
      'a path going up',
      { INPUT_PATH: '../outside' },
      "Invalid pattern '../outside'. Relative pathing '.' and '..' is not allowed.",
    ],
  ])('refuses %s before uploading', async (_, inputs, message) => {
    await startTarget();
    await writeFiles({ 'a.txt': 'a' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'a.txt', ...inputs });
    expect(exitCode).toBe(1);
    expect(stdout).toContain(`::error::${message}`);
    expect(runner.tokenRequests).toEqual([]);
  });

  it('names a required input it did not get', async () => {
    await startTarget();
    const { exitCode, stdout } = await runAction({});
    expect(exitCode).toBe(1);
    expect(stdout).toContain('::error::Input required and not supplied: path');
  });

  it('refuses to zip a path NTFS could not unpack', async () => {
    await startTarget();
    await writeFiles({ 'odd/what?.txt': 'x', 'odd/fine.txt': 'y' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'odd' });
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      '::error::The path for one of the files in artifact is not valid: what?.txt.',
    );
    expect(runner.tokenRequests).toEqual([]);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it('follows a symlink into the zip, and leaves a broken one out', async () => {
    await startTarget();
    await writeFiles({ 'real/data.txt': 'd' });
    await mkdir(join(workDir, 'links'));
    await symlink(join(workDir, 'real', 'data.txt'), join(workDir, 'links', 'data.txt'));
    await symlink(join(workDir, 'nowhere'), join(workDir, 'links', 'broken'));
    const { exitCode } = await runAction({ INPUT_PATH: 'links' });
    expect(exitCode).toBe(0);
    expect(await downloadUnzipped()).toEqual({ 'data.txt': base64('d') });
  });

  // The test server's are 7 and 30 days, and a bucket's are always 90.
  const [defaultHours, maximumHours] = kind === 'server' ? [168, 720] : [2160, 2160];
  it.each([
    ['unset', {}, defaultHours],
    ['0', { 'INPUT_RETENTION-DAYS': '0' }, defaultHours],
    ['2', { 'INPUT_RETENTION-DAYS': '2' }, 48],
    ['over the maximum', { 'INPUT_RETENTION-DAYS': '500' }, maximumHours],
  ])(
    'with retention-days %s, keeps the file as long as the target says',
    async (_, inputs, hours) => {
      await startTarget();
      await writeFiles({ 'a.txt': 'a' });
      const { exitCode } = await runAction({ INPUT_PATH: 'a.txt', ...inputs });
      expect(exitCode).toBe(0);
      const expiresAt = Temporal.Instant.from((await readOutputs())['expires-at'] ?? '');
      const untilExpiry = expiresAt.since(Temporal.Now.instant()).total('hours');
      expect(untilExpiry).toBeGreaterThan(hours - 1);
      expect(untilExpiry).toBeLessThanOrEqual(hours);
    },
  );

  it("fails on a negative retention with the target's message", async () => {
    await startTarget();
    await writeFiles({ 'a.txt': 'a' });
    const { exitCode, stdout } = await runAction({
      INPUT_PATH: 'a.txt',
      'INPUT_RETENTION-DAYS': '-1',
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain('::error::retention-days must be a positive integer');
  });

  it('removes the zip after a success', async () => {
    await startTarget();
    await writeFiles({ 'a.txt': 'a' });
    expect((await runAction({ INPUT_PATH: 'a.txt' })).exitCode).toBe(0);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it('removes the zip after a refusal', async () => {
    await startTarget();
    await writeFiles({ 'a.txt': 'a' });
    expect((await runAction({ INPUT_PATH: 'a.txt', INPUT_NAME: '.bad' })).exitCode).toBe(1);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it.runIf(kind === 'server')(
    'keeps the zip across retries, zipping once, then removes it',
    async () => {
      const bodies: Buffer[] = [];
      const artifactServer = createServer(async (req, res) => {
        if (req.method !== 'POST') return void res.writeHead(404).end();
        bodies.push(Buffer.concat(await Array.fromAsync(req)));
        const isFirst = bodies.length === 1;
        res
          .writeHead(isFirst ? 500 : 201, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify(
              isFirst
                ? { error: 'try again' }
                : { id: 'an-id', links: { home: 'http://x/a' }, expiresAt: 'x' },
            ),
          );
        return undefined;
      });
      await useFakeServer(artifactServer);
      await writeFiles({ 'a.txt': 'a' });

      const { exitCode, stderr } = await runAction({ INPUT_PATH: 'a.txt' });

      expect(stderr).toContain('Attempt 1 failed (try again)');
      expect(exitCode).toBe(0);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(await readdir(runnerTemp)).toEqual([]);
    },
  );

  describe('one name in one run attempt', () => {
    const uploadFile = async (content: string, inputs: Record<string, string> = {}) => {
      await writeFiles({ 'app.bin': content });
      await rm(outputPath, { force: true });
      const result = await runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false', ...inputs });
      return {
        ...result,
        outputs: result.exitCode === 0 ? await readOutputs() : {},
      };
    };

    const statusOfLink = async (url: string | undefined) =>
      (await fetch(requireTarget().reachable(url ?? ''))).status;

    /** The ID of every artifact the target holds the data of. */
    const artifactsStored = async () => {
      const active = requireTarget();
      if (active.kind === 'server') return readdir(join(runner.storeDir, 'artifacts'));
      return (await active.raw.keys('artifacts/')).map(key => key.split('/')[1] ?? '');
    };

    it('gives a zip the digest of the zip, as it gives a file the file', async () => {
      await startTarget();
      await writeFiles({ 'dist/a.txt': 'a' });
      expect((await runAction({ INPUT_PATH: 'dist' })).exitCode).toBe(0);
      const outputs = await readOutputs();
      const zip = await downloadOutput(outputs['artifact-url']);
      expect(outputs['artifact-digest']).toBe(createHash('sha256').update(zip).digest('hex'));
    });

    it('fails on other content, leaving the first upload working', async () => {
      await startTarget();
      const first = await uploadFile('first');

      const second = await uploadFile('second');

      expect(second.exitCode).toBe(1);
      expect(second.stdout).toMatch(/^::error::An artifact with this name already exists/m);
      // A refusal the server means is not retried.
      expectTokenRequests(2);
      await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
      expect(await statusOfLink(first.outputs['artifact-url'])).toBe(200);
    });

    it('with overwrite, replaces it, and the old link stops working', async () => {
      await startTarget();
      const first = await uploadFile('first');

      const second = await uploadFile('second', { INPUT_OVERWRITE: 'true' });

      expect(second.exitCode).toBe(0);
      expect(second.outputs['artifact-id']).not.toBe(first.outputs['artifact-id']);
      expect(requireTarget().goneLinkStatuses).toContain(
        await statusOfLink(first.outputs['artifact-url']),
      );
      expect(Buffer.from(await downloadOutput(second.outputs['artifact-url'])).toString()).toBe(
        'second',
      );
    });

    it('answers the same content with the artifact already there', async () => {
      await startTarget();
      const first = await uploadFile('same');
      const second = await uploadFile('same');
      expect(second.exitCode).toBe(0);
      expect(second.outputs).toEqual(first.outputs);
    });

    it('needs none of a large body to answer the same content', { timeout: 30_000 }, async () => {
      await startTarget();
      const path = join(rootDir, 'big.bin');
      await writeFile(path, '');
      await truncate(path, 256 * 1024 ** 2);
      const inputs = { INPUT_PATH: path, INPUT_ARCHIVE: 'false' };
      expect((await runAction(inputs)).exitCode).toBe(0);
      const first = await readOutputs();

      await rm(outputPath);
      expect((await runAction(inputs)).exitCode).toBe(0);
      expect(await readOutputs()).toEqual(first);
    });

    it('keeps a re-run apart: a new attempt holds the name afresh', async () => {
      await startTarget();
      const first = await uploadFile('first');

      runner.actAs({ run_attempt: '2' });
      const rerun = await uploadFile('from the re-run');

      expect(rerun.exitCode).toBe(0);
      expect(rerun.outputs['artifact-id']).not.toBe(first.outputs['artifact-id']);
      expect(await statusOfLink(first.outputs['artifact-url'])).toBe(200);
      expect(await statusOfLink(rerun.outputs['artifact-url'])).toBe(200);
    });

    it.each([
      ['repository', { repository_id: '8', repository: 'fishballapp/other' }],
      ['run', { run_id: '101' }],
    ])('keeps another %s apart', async (_, claims) => {
      await startTarget();
      const first = await uploadFile('first');

      runner.actAs(claims);
      const other = await uploadFile('other', { INPUT_OVERWRITE: 'true' });

      expect(other.exitCode).toBe(0);
      expect(await statusOfLink(first.outputs['artifact-url'])).toBe(200);
    });

    it('lets one of two jobs racing for the name win', async () => {
      await startTarget();
      await writeFiles({ 'one.bin': 'one', 'two.bin': 'two' });
      const race = (file: string) =>
        runAction(
          { INPUT_PATH: file, INPUT_NAME: 'shared' },
          // Each job its own output file, as each job has on a runner.
          { GITHUB_OUTPUT: join(rootDir, `${file}.output`) },
        );

      const results = await Promise.all([race('one.bin'), race('two.bin')]);

      expect(results.map(({ exitCode }) => exitCode).toSorted()).toEqual([0, 1]);
      const loser = results.find(({ exitCode }) => exitCode === 1);
      expect(loser?.stdout).toContain('already exists on the workflow run');
      // The loser's own data is gone too.
      expect(await artifactsStored()).toHaveLength(1);
    });

    it('survives losing the answer to an upload that was stored', async () => {
      const active = await startTarget();
      let uploads = 0;
      // Passes on each upload, then for the first, hangs up in place of the target's answer.
      await active.interpose(request => {
        if (!active.isUpload(request)) return undefined;
        uploads += 1;
        return uploads === 1 ? 'lose-answer' : undefined;
      });
      await writeFiles({ 'app.bin': 'the build' });

      const { exitCode, stderr } = await runAction({
        INPUT_PATH: 'app.bin',
        INPUT_ARCHIVE: 'false',
      });

      expect(stderr).toContain('Attempt 1 failed');
      expect(exitCode).toBe(0);
      expect(uploads).toBe(2);
      const outputs = await readOutputs();
      expect(await artifactsStored()).toEqual([outputs['artifact-id']]);
      expect(Buffer.from(await downloadOutput(outputs['artifact-url'])).toString()).toBe(
        'the build',
      );
    });

    it.runIf(kind === 'server')(
      'fails when the file changes between its digest and its upload',
      async () => {
        await startFakeServer([{ status: 422, body: { error: "The body's SHA-256 is not that" } }]);
        await writeFiles({ 'app.bin': 'x' });
        const { exitCode, stdout } = await runAction({ INPUT_PATH: 'app.bin' });
        expect(exitCode).toBe(1);
        expect(stdout).toContain("::error::The body's SHA-256 is not that");
        expectTokenRequests(1);
      },
    );

    it.runIf(kind === 'server')('sends the digest and, only when set, overwrite', async () => {
      const requested: URL[] = [];
      const artifactServer = createServer((req, res) => {
        if (req.method !== 'POST') return void res.writeHead(404).end();
        requested.push(new URL(req.url ?? '', 'http://localhost'));
        req.resume();
        req.on('end', () => {
          res
            .writeHead(201, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ id: 'an-id', links: { home: 'http://x/a' }, expiresAt: 'x' }));
        });
        return undefined;
      });
      await useFakeServer(artifactServer);
      await writeFiles({ 'app.bin': 'x' });
      const digest = createHash('sha256').update('x').digest('hex');

      expect((await uploadFile('x')).exitCode).toBe(0);
      expect((await uploadFile('x', { INPUT_OVERWRITE: 'true' })).exitCode).toBe(0);

      expect(requested[0]?.searchParams.get('digest')).toBe(digest);
      expect(requested[0]?.searchParams.has('overwrite')).toBe(false);
      expect(requested[1]?.searchParams.get('overwrite')).toBe('true');
    });
  });

  it.runIf(kind === 'server')('removes the zip when the runner stops the step', async () => {
    const { promise: requested, resolve: onRequest } = Promise.withResolvers<void>();
    const artifactServer = createServer(req => {
      if (req.method === 'POST') onRequest();
    });
    await useFakeServer(artifactServer);
    await writeFiles({ 'a.txt': 'a' });

    const child = spawn(ACTION_NODE, [ACTION], {
      cwd: workDir,
      stdio: 'ignore',
      env: {
        ...runner.runnerEnv,
        'INPUT_SERVER-URL': serverUrl,
        INPUT_AUDIENCE: AUDIENCE,
        INPUT_PATH: 'a.txt',
      },
    });
    await requested;
    expect(await readdir(runnerTemp)).toHaveLength(1);

    child.kill('SIGTERM');
    await once(child, 'exit');
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it.runIf(kind === 'server')(
    'asks for the id-token permission when the runner gave no token vars',
    async () => {
      await startTarget();
      const path = join(rootDir, 'a.bin');
      await writeFile(path, 'x');
      const { exitCode, stdout } = await runAction(
        { INPUT_PATH: path },
        { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain('permissions: id-token: write');
    },
  );

  it("fails on another 4xx with the target's message, without retrying", async () => {
    await startTarget();
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path, INPUT_NAME: '.bad name' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::name must match/m);
    expectTokenRequests(1);
  });

  it('refuses 4 GiB or more up front, as Node would send the wrong Content-Length', async () => {
    await startTarget();
    const path = join(rootDir, 'huge.bin');
    await writeFile(path, '');
    await truncate(path, 4 * 1024 ** 3 + 1);
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path, INPUT_ARCHIVE: 'false' });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("::error::huge.bin is 4294967297 bytes, and Node can't upload");
    expect(runner.tokenRequests).toEqual([]);
  });

  it.runIf(kind === 'server')('reads the 413 of a file much bigger than the limit', async () => {
    target = await runner.startServerTarget({ maxFileBytes: 1024 });
    const path = join(rootDir, 'big.bin');
    await writeFile(path, '');
    await truncate(path, 256 * 1024 * 1024);
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path, INPUT_ARCHIVE: 'false' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::File is over the limit of 1024 bytes/m);
    expectTokenRequests(1);
  });

  it.runIf(kind === 'server')('retries a 5xx, minting a fresh token per attempt', async () => {
    let attempts = 0;
    target = await runner.startServerTarget(
      {},
      verifierAnswering(async () => {
        attempts += 1;
        return attempts === 1
          ? { kind: 'unavailable', reason: 'could not fetch the JWKS' }
          : {
              kind: 'verified',
              repository: 'fishballapp/private-thing',
              scope: { repositoryId: '7', runId: '100', runAttempt: '1' },
            };
      }),
    );
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stderr } = await runAction({ INPUT_PATH: path });
    expect(stderr).toContain('Attempt 1 failed (GitHub signing keys are unavailable)');
    expect(exitCode).toBe(0);
    expectTokenRequests(2);
  });

  const startFakeServer = async (answers: { status: number; body: unknown }[]) => {
    const remaining = [...answers];
    const artifactServer = createServer((req, res) => {
      // As on the token server: a loopback probe mustn't use up an answer.
      if (req.method !== 'POST') return void res.writeHead(404).end();
      req.resume();
      req.on('end', () => {
        const { status, body } = remaining.shift() ?? { status: 500, body: {} };
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      });
    });
    await useFakeServer(artifactServer);
  };

  it.runIf(kind === 'server').each([
    ['no links', { id: 'an-id', links: {}, expiresAt: '2030-01-01T00:00:00Z' }],
    ['no links object', { id: 'an-id', expiresAt: '2030-01-01T00:00:00Z' }],
    ['no expiry', { id: 'an-id', links: { home: 'http://x/a' } }],
    ['no ID', { links: { home: 'http://x/a' }, expiresAt: 'x' }],
    ['a line break in the ID', { id: 'a\nowned=1', links: { home: 'http://x/a' }, expiresAt: 'x' }],
    [
      'a line break in a link',
      { id: 'an-id', links: { home: 'http://x/a\nowned=1' }, expiresAt: 'x' },
    ],
    [
      'a line break in another link',
      { id: 'an-id', links: { a: 'http://x/a', b: 'b\nowned=1' }, expiresAt: 'x' },
    ],
    [
      'a line break in the expiry',
      { id: 'an-id', links: { home: 'http://x/a' }, expiresAt: 'x\nowned=1' },
    ],
  ])('refuses an answer with %s, writing no outputs', async (_, body) => {
    await startFakeServer([{ status: 201, body }]);
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::.* answered without a usable link/m);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it.runIf(kind === 'server')(
    'retries an answer cut short, which a stored upload may have been',
    async () => {
      let posts = 0;
      const stored = JSON.stringify({
        id: 'an-id',
        links: { home: 'http://x/a' },
        expiresAt: '2030-01-01T00:00:00Z',
      });
      const artifactServer = createServer((req, res) => {
        if (req.method !== 'POST') return void res.writeHead(404).end();
        req.resume();
        req.on('end', () => {
          posts += 1;
          const headers = { 'Content-Type': 'application/json', 'Content-Length': stored.length };
          if (posts > 1) return void res.writeHead(200, headers).end(stored);
          res.writeHead(201, headers).write(stored.slice(0, 5), () => res.destroy());
          return undefined;
        });
        return undefined;
      });
      await useFakeServer(artifactServer);
      const path = join(rootDir, 'a.bin');
      await writeFile(path, 'x');
      const { exitCode, stderr } = await runAction({ INPUT_PATH: path });
      expect(stderr).toContain('Attempt 1 failed');
      expect(exitCode).toBe(0);
      expect(posts).toBe(2);
      expect((await readOutputs())['artifact-id']).toBe('an-id');
    },
  );

  it.runIf(kind === 'server')(
    "keeps a server's message from starting a workflow command",
    async () => {
      await startFakeServer([
        { status: 500, body: { error: 'boom\n::warning::injected' } },
        { status: 201, body: { id: 'an-id', links: { home: 'http://x/a' }, expiresAt: 'x' } },
      ]);
      const path = join(rootDir, 'a.bin');
      await writeFile(path, 'x');
      const { exitCode, stdout, stderr } = await runAction({ INPUT_PATH: path });
      expect(exitCode).toBe(0);
      expect(stdout).not.toMatch(/^::warning::/m);
      expect(stderr).not.toMatch(/^::warning::/m);
    },
  );

  it.runIf(kind === 'server')(
    'gives up on a network error after retrying, with the cause',
    {
      timeout: 20_000,
    },
    async () => {
      const nothing = createServer();
      serverUrl = await listenOnLoopback(nothing);
      await closeServer(nothing);
      const path = join(rootDir, 'a.bin');
      await writeFile(path, 'x');
      const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/^::error::fetch failed: .*ECONNREFUSED/m);
      expectTokenRequests(4);
    },
  );
});
