import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ACTION } from '../tsdown.config.ts';
import {
  AUDIENCE,
  buildBundle,
  exitCodeOf,
  generateRunnerKeys,
  PEAK_IN_PARTS_BYTES,
  PEAK_REPORTER,
  REQUEST_TOKEN,
  removeBundle,
  startRunner,
  TARGET_KINDS,
  TEST_MULTIPART_FROM_BYTES,
  UNUSUAL_NAME,
  withSmallMultipart,
} from './action-harness.ts';
import { closeServer, listenOnLoopback, verifierAnswering } from './test-support.ts';

vi.mock('./protocol.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./protocol.ts')>()),
  // TEST_MULTIPART_FROM_BYTES, which a hoisted mock can't import.
  MULTIPART_FROM_BYTES: 32 * 1024 ** 2,
}));

let ACTION: string;
const UPLOAD_ID = 'U'.repeat(43);
const STORED = { id: UPLOAD_ID, links: { home: 'http://x/a' }, expiresAt: 'x' };

type UploadStep = (req: IncomingMessage, res: ServerResponse) => unknown;

const answerJson = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

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
    ACTION = await buildBundle(withSmallMultipart(UPLOAD_ACTION));
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
    if (kind !== 's3') expect(runner.tokenRequests).toHaveLength(count);
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

    if (kind !== 's3') {
      // One to start and one to commit, so a long upload can't outlive its token. The audience joins
      // a query string the URL already has, with the runner's bearer token.
      expect(runner.tokenRequests).toHaveLength(2);
      expect(runner.tokenRequests[0]?.url.searchParams.get('api-version')).toBe('2.0');
      expect(runner.tokenRequests[0]?.url.searchParams.get('audience')).toBe(AUDIENCE);
      expect(runner.tokenRequests[0]?.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
    }

    const outputs = await readOutputs();
    const links = JSON.parse(outputs.links ?? '') as Record<string, string>;
    expect(Object.keys(links)).toEqual(kind === 's3' ? ['s3'] : ['home', 'tailscale']);
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
    expect(peakBytes).toBeLessThan(kind === 'server' ? fileBytes / 2 : PEAK_IN_PARTS_BYTES);
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

  it('with archive false, takes a hidden file under its own name', async () => {
    await startTarget();
    await writeFiles({ '.env': 'x' });
    const { exitCode, stdout } = await runAction({
      INPUT_PATH: '.env',
      INPUT_ARCHIVE: 'false',
      'INPUT_INCLUDE-HIDDEN-FILES': 'true',
    });
    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);
    expect((await readOutputs())['artifact-url']).toMatch(/\/\.env$/);
  });

  it('prints each link, as upstream prints its URL, and takes any name upstream does', async () => {
    await startTarget();
    const content = 'an unusual name';
    await writeFiles({ 'a.txt': content });
    const zipped = await runAction({ INPUT_PATH: 'a.txt', INPUT_NAME: UNUSUAL_NAME });
    expect(zipped.stdout).not.toContain('::error::');
    expect(zipped.exitCode).toBe(0);
    const zippedLinks = JSON.parse((await readOutputs()).links ?? '') as Record<string, string>;
    for (const link of Object.values(zippedLinks)) {
      expect(zipped.stdout).toContain(`Artifact download URL: ${link}`);
      expect(new URL(link).pathname).toMatch(/\/[^/]*%27%E4%BD%A0%E5%A5%BD\.zip$/u);
    }
    const [zippedLink = ''] = Object.values(zippedLinks);
    const [entry] = Object.values(unzipSync(await downloadOutput(zippedLink)));
    expect(Buffer.from(entry ?? []).toString()).toBe(content);

    await writeFiles({ [`plain/${UNUSUAL_NAME}`]: content });
    const plain = await runAction({ INPUT_PATH: 'plain/*', INPUT_ARCHIVE: 'false' });
    expect(plain.stdout).not.toContain('::error::');
    expect(plain.exitCode).toBe(0);
    const plainLink = (await readOutputs())['artifact-url'] ?? '';
    expect(Buffer.from(await downloadOutput(plainLink)).toString()).toBe(content);
  });

  it.each(['no/slash', 'a"quote', 'a:colon', '..'])('fails on %s as a name', async name => {
    await startTarget();
    await writeFiles({ 'a.txt': 'x' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'a.txt', INPUT_NAME: name });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::name must be 1 to 255 bytes/m);
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
  const [defaultHours, maximumHours] = kind === 's3' ? [2160, 2160] : [168, 720];
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
    expect((await runAction({ INPUT_PATH: 'a.txt', INPUT_NAME: 'a/bad' })).exitCode).toBe(1);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it.runIf(kind === 'server')(
    'keeps the zip across retries, zipping once, then removes it',
    async () => {
      const bodies: Buffer[] = [];
      await useUploadServer({
        put: async (req, res) => {
          bodies.push(Buffer.concat(await Array.fromAsync(req)));
          if (bodies.length > 1) return void res.writeHead(200).end();
          return void answerJson(res, 500, { error: 'try again' });
        },
      });
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
      // Two for the first upload, and a refusal the server means is not retried.
      expectTokenRequests(3);
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
      const stored = await artifactsStored();
      expect(stored).toContain(outputs['artifact-id']);
      // A server in front of a bucket can't tell a body arrived, so the first waits for the lifecycle rule.
      expect(stored).toHaveLength(kind === 'server-s3' ? 2 : 1);
      expect(Buffer.from(await downloadOutput(outputs['artifact-url'])).toString()).toBe(
        'the build',
      );
    });

    it.runIf(kind === 'server')(
      'fails when the file changes between its digest and its upload',
      async () => {
        await useUploadServer({
          put: async (req, res) => {
            req.resume();
            await once(req, 'end');
            answerJson(res, 422, { error: "The body's SHA-256 is not that" });
          },
        });
        await writeFiles({ 'app.bin': 'x' });
        const { exitCode, stdout } = await runAction({ INPUT_PATH: 'app.bin' });
        expect(exitCode).toBe(1);
        expect(stdout).toContain("::error::The body's SHA-256 is not that");
        expectTokenRequests(1);
      },
    );

    it.runIf(kind === 'server')(
      'declares the digest and size and, only when set, overwrite',
      async () => {
        const { creates, commits } = await useUploadServer();
        await writeFiles({ 'app.bin': 'x' });
        const digest = createHash('sha256').update('x').digest('hex');

        expect((await uploadFile('x')).exitCode).toBe(0);
        expect((await uploadFile('x', { INPUT_OVERWRITE: 'true' })).exitCode).toBe(0);

        expect(creates[0]?.searchParams.get('digest')).toBe(digest);
        expect(creates[0]?.searchParams.get('size')).toBe('1');
        expect(creates[0]?.searchParams.has('overwrite')).toBe(false);
        expect(creates[1]?.searchParams.get('overwrite')).toBe('true');
        // The commit says the same again.
        expect(commits.map(({ search }) => search)).toEqual(creates.map(({ search }) => search));
      },
    );

    it.runIf(kind === 'server')(
      'needs neither the body nor a commit for what is stored',
      async () => {
        const active = await startTarget();
        const seen: string[] = [];
        await active.interpose(({ method, url }) => {
          seen.push(`${method} ${url?.split('?')[0]?.replace(/[A-Za-z0-9_-]{43}/u, '<id>')}`);
          return undefined;
        });
        const first = await uploadFile('the build');
        expect(seen).toEqual(['POST /uploads', 'PUT /uploads/<id>', 'POST /uploads/<id>/commit']);
        seen.length = 0;

        const second = await uploadFile('the build');

        expect(second.exitCode).toBe(0);
        expect(second.outputs).toEqual(first.outputs);
        expect(seen).toEqual(['POST /uploads']);
      },
    );

    it.runIf(kind === 'server')('survives losing the answer to a commit that landed', async () => {
      const active = await startTarget();
      const seen: string[] = [];
      await active.interpose(({ method, url = '' }) => {
        const route = `${method} ${url.split('?')[0]?.replace(/[A-Za-z0-9_-]{43}/u, '<id>')}`;
        seen.push(route);
        return route === 'POST /uploads/<id>/commit' ? 'lose-answer' : undefined;
      });

      const result = await uploadFile('the build');

      expect(result.stderr).toContain('Attempt 1 failed (The upload failed');
      expect(result.exitCode).toBe(0);
      // The next attempt's first step finds the digest stored, and that's all it takes.
      expect(seen).toEqual([
        'POST /uploads',
        'PUT /uploads/<id>',
        'POST /uploads/<id>/commit',
        'POST /uploads',
      ]);
      expect(await artifactsStored()).toEqual([result.outputs['artifact-id']]);
      expect(Buffer.from(await downloadOutput(result.outputs['artifact-url'])).toString()).toBe(
        'the build',
      );
      expect(await readdir(join(runner.storeDir, 'tmp'))).toEqual([]);
    });
  });

  /**
   * A server a test wrote, taking uploads as the real one does, with the steps the test cares about
   * its own. A probe of a loopback port asks for neither of these, so it uses up nothing.
   */
  const useUploadServer = async ({
    create = (_req, res) =>
      answerJson(res, 201, {
        upload: { kind: 'single', id: UPLOAD_ID, url: `/uploads/${UPLOAD_ID}`, headers: {} },
      }),
    put = (req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200).end());
    },
    commit = (_req, res) => answerJson(res, 201, STORED),
  }: {
    create?: UploadStep;
    put?: UploadStep;
    commit?: UploadStep;
  } = {}) => {
    const creates: URL[] = [];
    const commits: URL[] = [];
    const puts: { url: string; headers: IncomingHttpHeaders }[] = [];
    await useFakeServer(
      createServer((req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        if (req.method === 'POST' && url.pathname.endsWith('/commit')) {
          commits.push(url);
          return void commit(req, res);
        }
        if (req.method === 'POST') {
          creates.push(url);
          return void create(req, res);
        }
        if (req.method === 'PUT') {
          puts.push({ url: req.url ?? '', headers: req.headers });
          return void put(req, res);
        }
        return void res.writeHead(404).end();
      }),
    );
    return { creates, commits, puts };
  };

  it.runIf(kind === 'server')(
    'sends the body with exactly the headers given, and no token',
    async () => {
      const headers = {
        'content-type': 'application/x-signed',
        'content-disposition': 'attachment; filename="app.bin"',
        'content-length': '1',
        'x-amz-checksum-sha256': 'abc=',
      };
      const { puts } = await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: { kind: 'single', id: UPLOAD_ID, url: `/uploads/${UPLOAD_ID}`, headers },
          }),
      });
      await writeFiles({ 'app.bin': 'x' });

      expect((await runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false' })).exitCode).toBe(0);

      expect(puts).toHaveLength(1);
      expect(puts[0]?.headers).toMatchObject(headers);
      expect(puts[0]?.headers).not.toHaveProperty('authorization');
      expect(runner.tokenRequests).toHaveLength(2);
    },
  );

  it.runIf(kind === 'server')('sends no content type it was not given', async () => {
    const { puts } = await useUploadServer();
    await writeFiles({ 'app.bin': 'x' });
    expect((await runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false' })).exitCode).toBe(0);
    expect(puts[0]?.headers).not.toHaveProperty('content-type');
    expect(puts[0]?.headers['content-length']).toBe('1');
  });

  it.runIf(kind === 'server')('sends an empty file with a length of nothing', async () => {
    const { puts } = await useUploadServer();
    await writeFiles({ 'empty.bin': '' });
    expect((await runAction({ INPUT_PATH: 'empty.bin', INPUT_ARCHIVE: 'false' })).exitCode).toBe(0);
    expect(puts[0]?.headers['content-length']).toBe('0');
  });

  it.runIf(kind === 'server')('takes an absolute URL as it is, query and all', async () => {
    const signed = `/elsewhere/${UPLOAD_ID}?X-Amz-Signature=a%2Fb%2Bc&X-Amz-Credential=k%2F20261103%2Fauto`;
    const { puts } = await useUploadServer({
      create: (req, res) =>
        answerJson(res, 201, {
          upload: {
            kind: 'single',
            id: UPLOAD_ID,
            url: `http://${req.headers.host}${signed}`,
            headers: {},
          },
        }),
    });
    await writeFiles({ 'app.bin': 'x' });
    expect((await runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false' })).exitCode).toBe(0);
    expect(puts[0]?.url).toBe(signed);
  });

  it.runIf(kind === 'server')(
    'resolves a path against server-url, keeping any path of its own',
    async () => {
      const { creates, commits, puts } = await useUploadServer();
      await writeFiles({ 'app.bin': 'x' });

      const { exitCode } = await runAction({
        INPUT_PATH: 'app.bin',
        INPUT_ARCHIVE: 'false',
        'INPUT_SERVER-URL': `${serverUrl}/behind/a/proxy/`,
      });

      expect(exitCode).toBe(0);
      expect(creates[0]?.pathname).toBe('/behind/a/proxy/uploads');
      expect(puts[0]?.url).toBe(`/behind/a/proxy/uploads/${UPLOAD_ID}`);
      expect(commits[0]?.pathname).toBe(`/behind/a/proxy/uploads/${UPLOAD_ID}/commit`);
    },
  );

  it.runIf(kind === 'server')('reaches the server by server-url, and no link base', async () => {
    // The target's link bases are ones a runner can't reach, so any use of them would fail.
    await startTarget();
    await writeFiles({ 'app.bin': 'x' });
    const { exitCode } = await runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false' });
    expect(exitCode).toBe(0);
    expect((await readOutputs())['artifact-url']).toMatch(/^http:\/\/127\.0\.0\.1:1\//u);
  });

  describe.runIf(kind === 'server')('an upload URL, which is a credential', () => {
    const SIGNATURE = 'X-Amz-Signature=this-must-not-be-seen';

    const expectUnseen = async (result: { stdout: string; stderr: string }) => {
      const outputs = await readFile(outputPath, 'utf8').catch(() => '');
      for (const seen of [result.stdout, result.stderr, outputs]) {
        expect(seen).not.toContain(UPLOAD_ID);
        expect(seen).not.toContain(SIGNATURE);
      }
    };

    const run = async () => {
      await writeFiles({ 'app.bin': 'x' });
      return runAction({ INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false' });
    };

    it.each<[string, UploadStep]>([
      ['the connection is cut', req => void req.socket.destroy()],
      ['a 5xx answers it', (_req, res) => answerJson(res, 502, { error: 'bad gateway' })],
      ['a 5xx with no message answers it', (_req, res) => void res.writeHead(503).end('<html>')],
    ])('stays out of everything when %s', { timeout: 20_000 }, async (_, put) => {
      await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: {
              kind: 'single',
              id: UPLOAD_ID,
              url: `/uploads/${UPLOAD_ID}?${SIGNATURE}`,
              headers: {},
            },
          }),
        put,
      });

      const result = await run();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Attempt 3 failed');
      expect(result.stdout).toContain('::error::');
      await expectUnseen(result);
    });

    it('stays out of everything when nothing listens there', { timeout: 20_000 }, async () => {
      const nothing = createServer();
      const closed = await listenOnLoopback(nothing);
      await closeServer(nothing);
      await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: {
              kind: 'single',
              id: UPLOAD_ID,
              url: `${closed}/uploads/${UPLOAD_ID}?${SIGNATURE}`,
              headers: {},
            },
          }),
      });

      const result = await run();

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/^::error::The upload failed: ECONNREFUSED/m);
      await expectUnseen(result);
    });

    it('stays out of everything when a redirect answers it', { timeout: 20_000 }, async () => {
      await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: {
              kind: 'single',
              id: UPLOAD_ID,
              url: `/uploads/${UPLOAD_ID}?${SIGNATURE}`,
              headers: {},
            },
          }),
        put: (_req, res) => void res.writeHead(307, { Location: '/elsewhere' }).end(),
      });

      const result = await run();

      expect(result.exitCode).toBe(1);
      await expectUnseen(result);
    });

    it('stays out of everything when it is not a URL at all', async () => {
      await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: {
              kind: 'single',
              id: UPLOAD_ID,
              url: `http://[${UPLOAD_ID}?${SIGNATURE}`,
              headers: {},
            },
          }),
      });

      const result = await run();

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('answered without a usable upload');
      await expectUnseen(result);
    });

    it('stays out of everything when the commit fails', { timeout: 20_000 }, async () => {
      await useUploadServer({ commit: req => void req.socket.destroy() });

      const result = await run();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Attempt 3 failed (The upload failed');
      await expectUnseen(result);
    });

    it('stays out of everything when a commit is cut short', { timeout: 20_000 }, async () => {
      await useUploadServer({
        commit: (_req, res) => {
          res
            .writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': 100 })
            .write('{', () => res.destroy());
        },
      });

      const result = await run();

      expect(result.exitCode).toBe(1);
      await expectUnseen(result);
    });

    it('stays off stdout on the command line too', { timeout: 20_000 }, async () => {
      await useUploadServer({
        create: (_req, res) =>
          answerJson(res, 201, {
            upload: {
              kind: 'single',
              id: UPLOAD_ID,
              url: `/uploads/${UPLOAD_ID}?${SIGNATURE}`,
              headers: {},
            },
          }),
        put: req => void req.socket.destroy(),
      });
      await writeFiles({ 'app.bin': 'x' });

      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        resolve => {
          execFile(
            process.execPath,
            [
              new URL('./bin.ts', import.meta.url).pathname,
              'upload',
              '--server-url',
              serverUrl,
              '--audience',
              AUDIENCE,
              '--path',
              'app.bin',
              '--archive',
              'false',
            ],
            { cwd: workDir, env: runner.runnerEnv },
            (error, stdout, stderr) => resolve({ exitCode: exitCodeOf(error), stdout, stderr }),
          );
        },
      );

      expect(result.exitCode).toBe(1);
      await expectUnseen(result);
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
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path, INPUT_NAME: 'a/bad name' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::name must be 1 to 255 bytes/m);
    expectTokenRequests(1);
  });

  it.runIf(kind === 'server')(
    'sends 4 GiB or more to a disk as one stream, as Node would send the wrong Content-Length',
    { timeout: 180_000 },
    async () => {
      let received = 0;
      const { creates, puts } = await useUploadServer({
        put: (req, res) => {
          req.on('data', chunk => {
            received += chunk.length;
          });
          req.on('end', () => res.writeHead(200).end());
        },
      });
      const size = 4 * 1024 ** 3 + 1;
      const path = join(rootDir, 'huge.bin');
      await writeFile(path, '');
      await truncate(path, size);

      const { exitCode } = await runAction({ INPUT_PATH: path, INPUT_ARCHIVE: 'false' });

      expect(exitCode).toBe(0);
      expect(creates[0]?.searchParams.get('size')).toBe(String(size));
      expect(puts).toHaveLength(1);
      expect(puts[0]?.headers['content-length']).toBeUndefined();
      expect(puts[0]?.headers['transfer-encoding']).toBe('chunked');
      expect(received).toBe(size);
    },
  );

  describe('a file big enough to go in parts', () => {
    const MIB = 1024 ** 2;
    const BIG_FILE_BYTES = TEST_MULTIPART_FROM_BYTES + 8 * MIB;

    /** Each MiB its own bytes, so a part out of place shows in the digest. */
    const writeBigFile = async () => {
      const path = join(rootDir, 'big.bin');
      const file = await open(path, 'w');
      const hash = createHash('sha256');
      for (let mib = 0; mib < BIG_FILE_BYTES / MIB; mib += 1) {
        const bytes = Buffer.alloc(MIB, mib);
        hash.update(bytes);
        await file.write(bytes);
      }
      await file.close();
      return { path, digest: hash.digest('hex') };
    };

    const partNumberOf = ({ url = '' }: IncomingMessage) =>
      new URL(url, 'http://localhost').searchParams.get('partNumber');

    const isFinishing = ({ method, url = '' }: IncomingMessage) =>
      method === 'POST' && new URL(url, 'http://localhost').searchParams.has('uploadId');

    const isStopping = ({ method, url = '' }: IncomingMessage) =>
      method === 'DELETE' && new URL(url, 'http://localhost').searchParams.has('uploadId');

    const bucketTarget = () => {
      const active = requireTarget();
      if (active.kind === 'server') throw new Error('This target has no bucket');
      return active;
    };

    const dataKeyOf = (id: string | undefined) => `artifacts/${id}/big.bin`;

    const uploadBigFile = async () => {
      const { path, digest } = await writeBigFile();
      const result = await runAction({ INPUT_PATH: path, INPUT_ARCHIVE: 'false' });
      return { ...result, digest };
    };

    it('arrives byte for byte, as one stream to a disk and in parts to a bucket', async () => {
      const active = await startTarget();
      const { exitCode, digest } = await uploadBigFile();

      expect(exitCode).toBe(0);
      const outputs = await readOutputs();
      expect(outputs['artifact-digest']).toBe(digest);
      const read = await fetch(active.reachable(outputs['artifact-url'] ?? ''));
      expect(read.status).toBe(200);
      const hash = createHash('sha256');
      for await (const chunk of read.body ?? []) hash.update(chunk);
      expect(hash.digest('hex')).toBe(digest);
      if (active.kind === 'server') return;
      const head = await active.raw.send('HEAD', dataKeyOf(outputs['artifact-id']));
      expect(head.headers.get('etag')).toMatch(/-3"$/u);
      expect(head.headers.get('content-length')).toBe(String(BIG_FILE_BYTES));
      expect(head.headers.get('content-type')).toBe('application/octet-stream');
      expect(head.headers.get('content-disposition')).toBe('attachment');
      expect(head.headers.get('x-amz-meta-run-scope')).toBe('7/100/1');
      expect(await active.raw.pendingUploads()).toEqual([]);
    });

    it.runIf(kind !== 'server')('sends a failed part again, and only that', async () => {
      const active = await startTarget();
      const sends = new Map<string | null, number>();
      await active.interpose(request => {
        const partNumber = partNumberOf(request);
        if (partNumber === null) return undefined;
        sends.set(partNumber, (sends.get(partNumber) ?? 0) + 1);
        return partNumber === '2' && sends.get('2') === 1
          ? { status: 503, message: 'Slow down' }
          : undefined;
      });

      const { exitCode, stderr } = await uploadBigFile();

      expect(exitCode).toBe(0);
      expect(stderr).toContain('Attempt 1 failed (Part 2: HTTP 503');
      expect(Object.fromEntries(sends)).toEqual({ '1': 1, '2': 2, '3': 1 });
    });

    it.runIf(kind !== 'server')('sends a part again when its answer is lost', async () => {
      const active = await startTarget();
      let sent = 0;
      await active.interpose(request => {
        if (partNumberOf(request) !== '3') return undefined;
        sent += 1;
        return sent === 1 ? 'lose-answer' : undefined;
      });

      const { exitCode, digest } = await uploadBigFile();

      expect(exitCode).toBe(0);
      expect(sent).toBe(2);
      expect((await readOutputs())['artifact-digest']).toBe(digest);
    });

    it.runIf(kind !== 'server')('fails at once on a refused part, and stops', async () => {
      const active = await startTarget();
      let sent = 0;
      let stops = 0;
      await active.interpose(request => {
        if (isStopping(request)) stops += 1;
        if (partNumberOf(request) !== '2') return undefined;
        sent += 1;
        return { status: 403, message: 'Nope' };
      });

      const { exitCode, stdout } = await uploadBigFile();

      expect(exitCode).toBe(1);
      expect(stdout).toContain('Part 2: HTTP 403: Refused');
      expect(sent).toBe(1);
      expect(stops).toBe(1);
      expect(await bucketTarget().raw.pendingUploads()).toEqual([]);
      expect(await bucketTarget().raw.keys('runs/')).toEqual([]);
    });

    it.runIf(kind === 's3')(
      'does not wait long for a stop that never answers',
      { timeout: 30_000 },
      async () => {
        const active = await startTarget();
        await active.interpose(request => {
          if (partNumberOf(request) === '1') return { status: 403, message: 'Nope' };
          return isStopping(request) ? 'hang' : undefined;
        });

        const started = Temporal.Now.instant();
        const { exitCode, stderr } = await uploadBigFile();

        expect(exitCode).toBe(1);
        expect(stderr).toContain("which the bucket's lifecycle rule will");
        expect(started.until(Temporal.Now.instant()).total('seconds')).toBeLessThan(25);
      },
    );

    it.runIf(kind !== 'server')(
      'still fails when it cannot stop',
      { timeout: 20_000 },
      async () => {
        const active = await startTarget();
        await active.interpose(request => {
          if (partNumberOf(request) === '1') return { status: 403, message: 'Nope' };
          return isStopping(request) ? { status: 500, message: 'No' } : undefined;
        });

        const { exitCode, stdout, stderr } = await uploadBigFile();

        expect(exitCode).toBe(1);
        expect(stdout).toContain('Part 1: HTTP 403');
        const log = active.kind === 'server-s3' ? active.serverLog.join('\n') : stderr;
        expect(log).toContain("which the bucket's lifecycle rule will");
      },
    );

    it.runIf(kind !== 'server')(
      'survives losing the answer to the object being finished',
      async () => {
        const active = await startTarget();
        let finishes = 0;
        await active.interpose(request => {
          if (!isFinishing(request)) return undefined;
          finishes += 1;
          return finishes === 1 ? 'lose-answer' : undefined;
        });

        const { exitCode, stdout, digest } = await uploadBigFile();

        expect(stdout).not.toContain('::error::');
        expect(exitCode).toBe(0);
        // The second answers `NoSuchUpload` on the fake and MinIO, and the object is what decides.
        expect(finishes).toBe(2);
        const outputs = await readOutputs();
        expect(outputs['artifact-digest']).toBe(digest);
        const head = await bucketTarget().raw.send('HEAD', dataKeyOf(outputs['artifact-id']));
        expect(head.headers.get('content-length')).toBe(String(BIG_FILE_BYTES));
      },
    );

    it.runIf(kind !== 'server')('finishes again when S3 says in a 200 that it failed', async () => {
      const active = await startTarget();
      let finishes = 0;
      await active.interpose(request => {
        if (!isFinishing(request)) return undefined;
        finishes += 1;
        return finishes === 1 ? { status: 200, message: 'We encountered an error' } : undefined;
      });

      const { exitCode } = await uploadBigFile();

      expect(exitCode).toBe(0);
      expect(finishes).toBe(2);
    });

    it.runIf(kind !== 'server')(
      'keeps what is in memory to what is in flight, whatever the size',
      { timeout: 120_000 },
      async () => {
        await startTarget();
        const fileBytes = 1024 * MIB;
        const path = join(rootDir, 'huge.bin');
        await writeFile(path, '');
        await truncate(path, fileBytes);
        const reporter = join(rootDir, 'report-peak-memory.mjs');
        await writeFile(reporter, PEAK_REPORTER);

        const { exitCode, stderr } = await runAction(
          { INPUT_PATH: path, INPUT_ARCHIVE: 'false' },
          { NODE_OPTIONS: `--import=${reporter}` },
        );

        expect(exitCode).toBe(0);
        const peakBytes = Number(/peak-kib=(\d+)/.exec(stderr)?.[1]) * 1024;
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(PEAK_IN_PARTS_BYTES);
      },
    );

    describe.runIf(kind !== 'server')('whose upload ID is a credential', () => {
      const expectUnseen = async (
        { stdout, stderr }: { stdout: string; stderr: string },
        uploadId: string | undefined,
      ) => {
        if (uploadId === undefined) throw new Error('No request held an upload ID');
        const outputs = await readFile(outputPath, 'utf8').catch(() => '');
        const active = requireTarget();
        const log = active.kind === 'server-s3' ? active.serverLog.join('\n') : '';
        for (const seen of [stdout, stderr, outputs, log]) {
          expect(seen).not.toContain(uploadId);
          expect(seen).not.toMatch(/X-Amz-(?:Signature|Credential)/u);
        }
      };

      const uploadIdOf = ({ url = '' }: IncomingMessage) =>
        new URL(url, 'http://localhost').searchParams.get('uploadId') ?? undefined;

      it('stays out of everything on a success', async () => {
        const active = await startTarget();
        let uploadId: string | undefined;
        await active.interpose(request => {
          uploadId ??= uploadIdOf(request);
          return undefined;
        });
        const result = await uploadBigFile();
        expect(result.exitCode).toBe(0);
        await expectUnseen(result, uploadId);
      });

      type EchoCase = [string, (request: IncomingMessage) => boolean, number];
      it.each<EchoCase>([
        ['a part refused', request => partNumberOf(request) === '1', 403],
        ['finishing', isFinishing, 400],
        ...(kind === 's3'
          ? // In front of a bucket, this retries on both sides of the server, for half a minute.
            [['finishing, failed', isFinishing, 500] satisfies EchoCase]
          : []),
      ])(
        'stays out of everything when S3 echoes it, on %s',
        {
          timeout: 20_000,
        },
        async (_, isTheOne, status) => {
          const active = await startTarget();
          let uploadId: string | undefined;
          await active.interpose(request => {
            uploadId ??= uploadIdOf(request);
            return isTheOne(request)
              ? { status, message: `no such upload as ${uploadIdOf(request)}` }
              : undefined;
          });
          const result = await uploadBigFile();
          expect(result.exitCode).toBe(1);
          await expectUnseen(result, uploadId);
        },
      );

      it('gives up on a part that keeps failing, and stops, saying nothing of it', {
        timeout: 20_000,
      }, async () => {
        const active = await startTarget();
        let uploadId: string | undefined;
        let sent = 0;
        await active.interpose(request => {
          uploadId ??= uploadIdOf(request);
          if (partNumberOf(request) !== '2') return undefined;
          sent += 1;
          return { status: 503, message: `no such upload as ${uploadIdOf(request)}` };
        });

        const result = await uploadBigFile();

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Attempt 3 failed (Part 2');
        expect(sent).toBe(4);
        expect(await bucketTarget().raw.pendingUploads()).toEqual([]);
        expect(await bucketTarget().raw.keys('runs/')).toEqual([]);
        await expectUnseen(result, uploadId);
      });

      it.runIf(kind === 's3')(
        'stays out of everything when the connection is cut',
        {
          timeout: 20_000,
        },
        async () => {
          const active = await startTarget();
          let uploadId: string | undefined;
          await active.interpose(request => {
            uploadId ??= uploadIdOf(request);
            return partNumberOf(request) === '1' ? 'lose-answer' : undefined;
          });
          const result = await uploadBigFile();
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('Attempt 3 failed (The upload failed');
          await expectUnseen(result, uploadId);
        },
      );
    });
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
    // Two for the attempt that failed and the one that started over, and one for its commit.
    expectTokenRequests(3);
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
    await startFakeServer([{ status: 200, body }]);
    const path = join(rootDir, 'a.bin');
    await writeFile(path, 'x');
    const { exitCode, stdout } = await runAction({ INPUT_PATH: path });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::.* answered without a usable link/m);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it.runIf(kind === 'server').each([
    ['no upload', {}],
    ['no ID', { upload: { kind: 'single', url: '/uploads/x', headers: {} } }],
    [
      'an ID that could lead elsewhere',
      { upload: { kind: 'single', id: '../..', url: '/x', headers: {} } },
    ],
    ['no URL', { upload: { kind: 'single', id: UPLOAD_ID, headers: {} } }],
    ['no headers', { upload: { kind: 'single', id: UPLOAD_ID, url: '/x' } }],
    [
      'a line break in a header',
      { upload: { kind: 'single', id: UPLOAD_ID, url: '/x', headers: { a: 'b\nc' } } },
    ],
  ])('refuses a new upload with %s, sending nothing', async (_, body) => {
    const { puts } = await useUploadServer({ create: (_req, res) => answerJson(res, 201, body) });
    await writeFiles({ 'a.bin': 'x' });
    const { exitCode, stdout } = await runAction({ INPUT_PATH: 'a.bin' });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^::error::.* answered without a usable upload/m);
    expect(puts).toEqual([]);
  });

  it.runIf(kind === 'server')(
    'refuses a link holding what the runner would read as a command, as it goes in the log',
    async () => {
      const links = { home: 'https://files.example/a##[stop-commands]pause' };
      await useUploadServer({
        commit: (_req, res) => answerJson(res, 201, { id: 'an-id', links, expiresAt: 'x' }),
      });
      await writeFiles({ 'a.bin': 'x' });
      const { exitCode, stdout } = await runAction({ INPUT_PATH: 'a.bin' });
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/^::error::.* answered without a usable link/m);
      expect(stdout).not.toContain('stop-commands');
    },
  );

  it.runIf(kind === 'server')(
    'refuses a commit answered with no usable link, writing no outputs',
    async () => {
      await useUploadServer({
        commit: (_req, res) => answerJson(res, 201, { id: 'an-id', links: {}, expiresAt: 'x' }),
      });
      await writeFiles({ 'a.bin': 'x' });
      const { exitCode, stdout } = await runAction({ INPUT_PATH: 'a.bin' });
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/^::error::.* answered without a usable link/m);
      await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
    },
  );

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
          res.writeHead(200, headers).write(stored.slice(0, 5), () => res.destroy());
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
        { status: 200, body: { id: 'an-id', links: { home: 'http://x/a' }, expiresAt: 'x' } },
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
