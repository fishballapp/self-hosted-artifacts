import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, openAsBlob } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DOWNLOAD_ACTION } from '../tsdown.config.ts';
import {
  AUDIENCE,
  buildBundle,
  generateRunnerKeys,
  PEAK_REPORTER,
  startRunner,
} from './action-harness.ts';
import { zipFiles } from './zip.ts';

const ACTION = new URL('../../../download/dist/action.mjs', import.meta.url).pathname;
const BIN = new URL('./bin.ts', import.meta.url).pathname;
// CI sets this to a Node 24 binary, as that is what the runner runs the action on.
const ACTION_NODE = process.env.ACTION_NODE ?? process.execPath;

const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');

type Stored = { id: string; name: string; digest: string; size: number };

describe('downloading', () => {
  let keys: CryptoKeyPair;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  let serverUrl: string;
  let destination: string;

  beforeAll(async () => {
    await buildBundle(DOWNLOAD_ACTION);
    keys = await generateRunnerKeys();
  }, 60_000);

  beforeEach(async () => {
    runner = await startRunner({ keys });
    destination = join(runner.rootDir, 'destination');
    serverUrl = '';
  });

  afterEach(async () => {
    await runner.stop();
  });

  const startServer = async () => {
    serverUrl = await runner.startArtifactServer();
  };

  /** Straight to the real server, as the job that uploaded would, with a real token. */
  const store = async (
    name: string,
    content: Uint8Array,
    run: Parameters<typeof runner.actAs>[0] = {},
  ): Promise<Stored> => {
    runner.actAs(run);
    const response = await fetch(`${serverUrl}/artifacts?name=${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await runner.signToken()}` },
      body: new Uint8Array(content),
    });
    runner.actAs({});
    expect(response.status).toBe(201);
    return (await response.json()) as Stored;
  };

  const storeZip = (
    name: string,
    files: Record<string, string>,
    run: Parameters<typeof runner.actAs>[0] = {},
  ) =>
    store(
      `${name}.zip`,
      zipSync(
        Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
      ),
      run,
    );

  const runAction = (
    inputs: Record<string, string> = {},
    env: Record<string, string | undefined> = {},
  ) =>
    runner.runNode(ACTION_NODE, [ACTION], {
      'INPUT_SERVER-URL': serverUrl,
      INPUT_AUDIENCE: AUDIENCE,
      ...inputs,
      ...env,
    });

  const runCli = (command: string, args: readonly string[]) =>
    runner.runNode(
      process.execPath,
      [BIN, command, '--server-url', serverUrl, '--audience', AUDIENCE, ...args],
      {},
    );

  /** Every file below a directory, as `path: content`. */
  const treeOf = async (directory: string): Promise<Record<string, string>> => {
    if (!existsSync(directory)) return {};
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile());
    return Object.fromEntries(
      await Promise.all(
        files.map(async ({ parentPath, name }) => [
          join(parentPath, name).slice(directory.length + 1),
          await readFile(join(parentPath, name), 'utf8'),
        ]),
      ),
    );
  };

  /** Flips a byte of what `store` holds where `content` starts, keeping its size. */
  const corruptOnDisk = async ({ id }: Stored, content: string) => {
    const dataFile = join(runner.storeDir, 'artifacts', id, 'data');
    const bytes = await readFile(dataFile);
    const offset = bytes.indexOf(content);
    bytes.writeUInt8(bytes.readUInt8(offset) ^ 0xff, offset);
    await writeFile(dataFile, bytes);
  };

  const expectSucceeded = ({ exitCode, stdout }: { exitCode: number; stdout: string }) => {
    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);
  };

  describe('by name', () => {
    it('unpacks one artifact into path, with no folder for its name', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a', 'dir/b.txt': 'b' });
      await storeZip('other', { 'c.txt': 'c' });

      const result = await runAction({ INPUT_NAME: 'build', INPUT_PATH: destination });

      expectSucceeded(result);
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'a', 'dir/b.txt': 'b' });
      expect(await runner.readOutputs()).toEqual({ 'download-path': destination });
      expect(result.stdout).toContain('Total of 1 artifact(s) downloaded');
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('defaults to GITHUB_WORKSPACE', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_NAME: 'build' }));
      expect(await treeOf(runner.workDir)).toEqual({ 'a.txt': 'a' });
      expect(await runner.readOutputs()).toEqual({ 'download-path': runner.workDir });
    });

    it('defaults to the working directory without GITHUB_WORKSPACE', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_NAME: 'build' }, { GITHUB_WORKSPACE: undefined }));
      expect(await treeOf(runner.workDir)).toEqual({ 'a.txt': 'a' });
    });

    it('resolves a relative path, and expands `~`', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_NAME: 'build', INPUT_PATH: 'out/put' }));
      expect(await treeOf(join(runner.workDir, 'out/put'))).toEqual({ 'a.txt': 'a' });

      const home = join(runner.rootDir, 'home');
      await mkdir(home);
      expectSucceeded(
        await runAction({ INPUT_NAME: 'build', INPUT_PATH: '~/here' }, { HOME: home }),
      );
      expect(await treeOf(join(home, 'here'))).toEqual({ 'a.txt': 'a' });
    });

    it('replaces a file that is already there, and leaves what else it finds', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'new' });
      await mkdir(destination);
      await writeFile(join(destination, 'a.txt'), 'old');
      await writeFile(join(destination, 'b.txt'), 'kept');
      expectSucceeded(await runAction({ INPUT_NAME: 'build', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'new', 'b.txt': 'kept' });
    });

    it('restores permissions, without the bits that could raise them', async () => {
      await startServer();
      const source = join(runner.rootDir, 'run.sh');
      await writeFile(source, 'x');
      await chmod(source, 0o755);
      await storeZipOfFile('tool', source, runner.rootDir);
      expectSucceeded(await runAction({ INPUT_NAME: 'tool', INPUT_PATH: destination }));
      expect((await stat(join(destination, 'run.sh'))).mode & 0o7777).toBe(0o755);
    });

    it('makes the empty folders a zip holds', async () => {
      await startServer();
      await store(
        'build.zip',
        zipSync({ 'empty/deep/': new Uint8Array(0), 'a.txt': strToU8('a') }),
      );
      expectSucceeded(await runAction({ INPUT_NAME: 'build', INPUT_PATH: destination }));
      expect((await stat(join(destination, 'empty/deep'))).isDirectory()).toBe(true);
    });

    it('fails when nothing has the name', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      const { exitCode, stdout } = await runAction({ INPUT_NAME: 'nope', INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        "::error::Unable to download artifact(s): Artifact 'nope' not found",
      );
      expect(existsSync(destination)).toBe(false);
    });

    it('takes a zip over a file of the same name, and the file when there is no zip', async () => {
      await startServer();
      await store('thing', strToU8('a file'));
      expectSucceeded(await runAction({ INPUT_NAME: 'thing', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ thing: 'a file' });

      await storeZip('thing', { 'a.txt': 'a zip' });
      const second = join(runner.rootDir, 'second');
      expectSucceeded(await runAction({ INPUT_NAME: 'thing', INPUT_PATH: second }));
      expect(await treeOf(second)).toEqual({ 'a.txt': 'a zip' });
    });
  });

  describe('by pattern and all at once', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a', 'both.txt': 'from a' });
      await storeZip('build-b', { 'b.txt': 'b', 'both.txt': 'from b' });
      await storeZip('other', { 'c.txt': 'c' });
    });

    it('gives each match its own folder', async () => {
      const result = await runAction({ INPUT_PATTERN: 'build-*', INPUT_PATH: destination });
      expectSucceeded(result);
      expect(await treeOf(destination)).toEqual({
        'build-a/a.txt': 'a',
        'build-a/both.txt': 'from a',
        'build-b/b.txt': 'b',
        'build-b/both.txt': 'from b',
      });
      expect(result.stdout).toContain('Total of 2 artifact(s) downloaded');
    });

    it('puts a lone match straight in path, as upstream does', async () => {
      expectSucceeded(await runAction({ INPUT_PATTERN: 'oth*', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'c.txt': 'c' });
    });

    it('with merge-multiple, puts them in one folder, and the last in name order wins', async () => {
      expectSucceeded(
        await runAction({
          INPUT_PATTERN: 'build-*',
          'INPUT_MERGE-MULTIPLE': 'true',
          INPUT_PATH: destination,
        }),
      );
      expect(await treeOf(destination)).toEqual({
        'a.txt': 'a',
        'b.txt': 'b',
        'both.txt': 'from b',
      });
    });

    it('takes every artifact with no name, IDs or pattern', async () => {
      expectSucceeded(await runAction({ INPUT_PATH: destination }));
      expect(Object.keys(await treeOf(destination)).toSorted()).toEqual([
        'build-a/a.txt',
        'build-a/both.txt',
        'build-b/b.txt',
        'build-b/both.txt',
        'other/c.txt',
      ]);
    });

    it('ignores a pattern beside a name', async () => {
      expectSucceeded(
        await runAction({ INPUT_NAME: 'other', INPUT_PATTERN: 'nope', INPUT_PATH: destination }),
      );
      expect(await treeOf(destination)).toEqual({ 'c.txt': 'c' });
    });

    it('succeeds with nothing to do when a pattern matches nothing', async () => {
      const result = await runAction({ INPUT_PATTERN: 'nope-*', INPUT_PATH: destination });
      expectSucceeded(result);
      expect(result.stdout).toContain('Total of 0 artifact(s) downloaded');
      expect(await runner.readOutputs()).toEqual({ 'download-path': destination });
      expect(existsSync(destination)).toBe(false);
    });
  });

  it('succeeds with nothing to do in a run with no artifacts', async () => {
    await startServer();
    const result = await runAction({ INPUT_PATH: destination });
    expectSucceeded(result);
    expect(result.stdout).toContain('Total of 0 artifact(s) downloaded');
  });

  describe('by ID', () => {
    it('unpacks one straight into path', async () => {
      await startServer();
      const { id } = await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ 'INPUT_ARTIFACT-IDS': id, INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'a' });
    });

    it('gives several a folder each, reading a list with spaces', async () => {
      await startServer();
      const a = await storeZip('a', { 'a.txt': 'a' });
      const b = await storeZip('b', { 'b.txt': 'b' });
      expectSucceeded(
        await runAction({ 'INPUT_ARTIFACT-IDS': `${a.id}, ${b.id},`, INPUT_PATH: destination }),
      );
      expect(await treeOf(destination)).toEqual({ 'a/a.txt': 'a', 'b/b.txt': 'b' });
    });

    it('warns about those it could not find, and fails with none', async () => {
      await startServer();
      const { id } = await storeZip('build', { 'a.txt': 'a' });
      const missing = 'a'.repeat(43);

      const partly = await runAction({
        'INPUT_ARTIFACT-IDS': `${id},${missing}`,
        INPUT_PATH: destination,
      });
      expectSucceeded(partly);
      expect(partly.stdout).toContain(
        `::warning::Could not find the following artifact IDs: ${missing}`,
      );

      const none = await runAction({ 'INPUT_ARTIFACT-IDS': missing, INPUT_PATH: destination });
      expect(none.exitCode).toBe(1);
      expect(none.stdout).toContain('None of the provided artifact IDs were found');
    });

    it("refuses another run's or repository's ID in the current run's scope", async () => {
      await startServer();
      const otherRun = await storeZip('a', { 'a.txt': 'a' }, { run_id: '200' });
      const otherRepository = await storeZip(
        'b',
        { 'b.txt': 'b' },
        {
          repository: 'fishballapp/other',
          repository_id: '8',
        },
      );

      for (const { id } of [otherRun, otherRepository]) {
        const { exitCode, stdout } = await runAction({
          'INPUT_ARTIFACT-IDS': id,
          INPUT_PATH: destination,
        });
        expect(exitCode).toBe(1);
        expect(stdout).toContain('None of the provided artifact IDs were found');
      }
      expect(existsSync(destination)).toBe(false);

      expectSucceeded(
        await runAction({
          'INPUT_ARTIFACT-IDS': otherRun.id,
          'INPUT_RUN-ID': '200',
          INPUT_PATH: destination,
        }),
      );
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'a' });
    });

    it.each([
      ['a number, as upstream has them', '12345', "Invalid artifact ID: '12345'"],
      ['nothing but commas', ' , ,', "No valid artifact IDs provided in 'artifact-ids' input"],
    ])('refuses %s', async (_, ids, message) => {
      await startServer();
      const { exitCode, stdout } = await runAction({ 'INPUT_ARTIFACT-IDS': ids });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(message);
    });

    it('refuses to go with a name', async () => {
      await startServer();
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'a',
        'INPUT_ARTIFACT-IDS': 'b'.repeat(43),
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Inputs 'name' and 'artifact-ids' cannot be used together");
    });
  });

  describe('from elsewhere', () => {
    it('reads another run of this repository with run-id alone', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'there' }, { run_id: '200' });
      await storeZip('build', { 'a.txt': 'here' });
      expectSucceeded(
        await runAction({ INPUT_NAME: 'build', 'INPUT_RUN-ID': '200', INPUT_PATH: destination }),
      );
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'there' });
    });

    it('reads another repository of the owner, given its name and run', async () => {
      await startServer();
      const other = { repository: 'fishballapp/Other', repository_id: '8', run_id: '200' };
      await storeZip('build', { 'a.txt': 'theirs' }, other);
      expectSucceeded(
        await runAction({
          INPUT_NAME: 'build',
          INPUT_REPOSITORY: 'fishballapp/other',
          'INPUT_RUN-ID': '200',
          INPUT_PATH: destination,
        }),
      );
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'theirs' });
    });

    it("looks in the job's own run when given only a repository, and finds nothing", async () => {
      await startServer();
      await storeZip(
        'build',
        { 'a.txt': 'theirs' },
        {
          repository: 'fishballapp/other',
          repository_id: '8',
          run_id: '200',
        },
      );
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'build',
        INPUT_REPOSITORY: 'fishballapp/other',
        INPUT_PATH: destination,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Artifact 'build' not found");
    });

    it('finds nothing in a repository that never uploaded', async () => {
      await startServer();
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'build',
        INPUT_REPOSITORY: 'fishballapp/nobody',
        'INPUT_RUN-ID': '1',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("Artifact 'build' not found");
    });

    it.each([
      ['a repository with no name', { INPUT_REPOSITORY: 'owner' }, "Invalid repository: 'owner'"],
      ['a repository too deep', { INPUT_REPOSITORY: 'a/b/c' }, "Invalid repository: 'a/b/c'"],
      ['a run that is no number', { 'INPUT_RUN-ID': 'abc' }, "Invalid run-id: 'abc'"],
    ])('refuses %s', async (_, inputs, message) => {
      await startServer();
      const { exitCode, stdout } = await runAction(inputs);
      expect(exitCode).toBe(1);
      expect(stdout).toContain(message);
    });

    it('accepts github-token, says it is ignored, and never prints it', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      const result = await runAction({
        INPUT_NAME: 'build',
        'INPUT_GITHUB-TOKEN': 'a-secret-token',
        INPUT_PATH: destination,
      });
      expectSucceeded(result);
      expect(result.stderr).toContain('github-token is ignored');
      expect(`${result.stdout}${result.stderr}`).not.toContain('a-secret-token');
      expect(result.stdout).not.toContain('::warning::');
    });
  });

  describe('across attempts', () => {
    it('takes the latest attempt that holds the name', async () => {
      await startServer();
      await storeZip('both', { 'a.txt': 'attempt 1' });
      await storeZip('both', { 'a.txt': 'attempt 2' }, { run_attempt: '2' });
      await storeZip('old', { 'b.txt': 'attempt 1' });

      expectSucceeded(await runAction({ INPUT_NAME: 'both', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'a.txt': 'attempt 2' });

      const everything = join(runner.rootDir, 'everything');
      expectSucceeded(await runAction({ INPUT_PATH: everything }));
      expect(await treeOf(everything)).toEqual({
        'both/a.txt': 'attempt 2',
        'old/b.txt': 'attempt 1',
      });
    });

    it("no longer finds an earlier attempt's ID, as upstream's list with latest doesn't", async () => {
      await startServer();
      const first = await storeZip('build', { 'a.txt': '1' });
      await storeZip('build', { 'a.txt': '2' }, { run_attempt: '2' });
      const { exitCode, stdout } = await runAction({ 'INPUT_ARTIFACT-IDS': first.id });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('None of the provided artifact IDs were found');
    });
  });

  describe('a digest that does not match', () => {
    const MESSAGE = "Artifact 'bad.zip' digest validation failed";
    const CONTENT = 'held as it is, so a flipped byte leaves a zip that still opens';
    const storeBadZip = async (name: string) => {
      const zip = zipSync({ 'a.txt': strToU8(CONTENT) }, { level: 0 });
      await corruptOnDisk(await store(name, zip), CONTENT);
    };

    const startWithBadArtifact = async () => {
      await startServer();
      await storeBadZip('bad.zip');
    };

    it('fails by default, unpacks nothing, and removes the temp file', async () => {
      await startWithBadArtifact();
      const { exitCode, stdout } = await runAction({ INPUT_NAME: 'bad', INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        "Digest validation failed for artifact(s): bad.zip. Use 'digest-mismatch: warn' to continue on mismatch.",
      );
      expect(await treeOf(destination)).toEqual({});
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('with error, still downloads the rest, naming each that failed', async () => {
      await startWithBadArtifact();
      await storeZip('good', { 'b.txt': 'b' });
      await storeBadZip('worse.zip');
      const { exitCode, stdout } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Digest validation failed for artifact(s): bad.zip, worse.zip.');
      expect(await treeOf(destination)).toEqual({ 'good/b.txt': 'b' });
    });

    it.each([
      ['warn', '::warning::', true],
      ['info', '', true],
      ['ignore', '', false],
    ])('with %s, carries on and unpacks it', async (mode, prefix, isMentioned) => {
      await startWithBadArtifact();
      const result = await runAction({
        INPUT_NAME: 'bad',
        'INPUT_DIGEST-MISMATCH': mode,
        INPUT_PATH: destination,
      });
      expectSucceeded(result);
      expect(`${result.stdout}${result.stderr}`.includes(MESSAGE)).toBe(isMentioned);
      if (prefix !== '') expect(result.stdout).toContain(`${prefix}${MESSAGE}`);
      if (prefix === '') expect(result.stdout).not.toContain('::warning::');
      const { 'a.txt': unpacked } = await treeOf(destination);
      expect(unpacked).toHaveLength(CONTENT.length);
      expect(unpacked).not.toBe(CONTENT);
    });

    it('with warn on a zip that no longer opens, says so before it fails', async () => {
      await startServer();
      const zip = zipSync({ 'a.txt': strToU8('a') });
      const stored = await store('bad.zip', zip);
      await writeFile(
        join(runner.storeDir, 'artifacts', stored.id, 'data'),
        new Uint8Array(zip.length),
      );
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'bad',
        'INPUT_DIGEST-MISMATCH': 'warn',
        INPUT_PATH: destination,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(`::warning::${MESSAGE}`);
      expect(stdout).toContain("Can't place bad.zip");
    });

    it('with warn on a plain file, keeps the file and succeeds', async () => {
      await startServer();
      await corruptOnDisk(await store('a.bin', strToU8('content')), 'content');
      const result = await runAction({
        INPUT_NAME: 'a.bin',
        'INPUT_DIGEST-MISMATCH': 'warn',
        INPUT_PATH: destination,
      });
      expectSucceeded(result);
      expect(result.stdout).toContain("::warning::Artifact 'a.bin' digest validation failed");
      expect(existsSync(join(destination, 'a.bin'))).toBe(true);
    });

    it('refuses a mode that does not exist', async () => {
      await startServer();
      const { exitCode, stdout } = await runAction({ 'INPUT_DIGEST-MISMATCH': 'shrug' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        "Invalid value for 'digest-mismatch': 'shrug'. Valid options are: ignore, info, warn, error",
      );
    });
  });

  describe('a file that is not a zip', () => {
    it('is written as that file, readable, under its own name', async () => {
      await startServer();
      await store('app.apk', strToU8('not a zip'));
      expectSucceeded(await runAction({ INPUT_NAME: 'app.apk', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'app.apk': 'not a zip' });
      expect((await stat(join(destination, 'app.apk'))).mode & 0o777).toBe(0o644);
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('is copied when RUNNER_TEMP is on another disk, where it can not move', async () => {
      await startServer();
      await store('app.apk', strToU8('apk'));
      const noRename = join(runner.rootDir, 'no-rename.mjs');
      await writeFile(
        noRename,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.rename = (_from, _to, callback) => {
  process.stderr.write('rename refused');
  callback(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
};
syncBuiltinESMExports();`,
      );
      const result = await runAction(
        { INPUT_NAME: 'app.apk', INPUT_PATH: destination },
        { NODE_OPTIONS: `--import=${noRename}` },
      );
      expectSucceeded(result);
      expect(result.stderr).toContain('rename refused');
      expect(await treeOf(destination)).toEqual({ 'app.apk': 'apk' });
      expect((await stat(join(destination, 'app.apk'))).mode & 0o777).toBe(0o644);
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('goes in a folder of its name among several, as upstream puts it', async () => {
      await startServer();
      await store('app.apk', strToU8('apk'));
      await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'app.apk/app.apk': 'apk', 'build/a.txt': 'a' });
    });

    it('is matched by its whole name in a pattern', async () => {
      await startServer();
      await store('app.apk', strToU8('apk'));
      await storeZip('build', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_PATTERN: '*.apk', INPUT_PATH: destination }));
      expect(await treeOf(destination)).toEqual({ 'app.apk': 'apk' });
    });

    it('replaces rather than follows a symlink that is already there', async () => {
      await startServer();
      await store('app.apk', strToU8('apk'));
      const outside = join(runner.rootDir, 'outside.txt');
      await writeFile(outside, 'untouched');
      await mkdir(destination);
      await symlink(outside, join(destination, 'app.apk'));
      expectSucceeded(await runAction({ INPUT_NAME: 'app.apk', INPUT_PATH: destination }));
      expect(await readFile(outside, 'utf8')).toBe('untouched');
      expect((await lstat(join(destination, 'app.apk'))).isSymbolicLink()).toBe(false);
    });
  });

  describe('skip-decompress', () => {
    it('keeps the zip as it is', async () => {
      await startServer();
      const zip = zipSync({ 'a.txt': strToU8('a') });
      await store('build.zip', zip);
      expectSucceeded(
        await runAction({
          INPUT_NAME: 'build',
          'INPUT_SKIP-DECOMPRESS': 'true',
          INPUT_PATH: destination,
        }),
      );
      expect(await readdir(destination)).toEqual(['build.zip']);
      expect(new Uint8Array(await readFile(join(destination, 'build.zip')))).toEqual(zip);
    });

    it('keeps each in its folder among several', async () => {
      await startServer();
      await storeZip('a', { 'a.txt': 'a' });
      await storeZip('b', { 'b.txt': 'b' });
      expectSucceeded(
        await runAction({ 'INPUT_SKIP-DECOMPRESS': 'true', INPUT_PATH: destination }),
      );
      expect(Object.keys(await treeOf(destination)).toSorted()).toEqual(['a/a.zip', 'b/b.zip']);
    });
  });

  describe('its inputs', () => {
    it.each([
      ['merge-multiple', { 'INPUT_MERGE-MULTIPLE': 'yes' }],
      ['skip-decompress', { 'INPUT_SKIP-DECOMPRESS': 'yes' }],
    ])('refuses a %s that is not a YAML boolean', async (name, inputs) => {
      await startServer();
      const { exitCode, stdout } = await runAction(inputs);
      expect(exitCode).toBe(1);
      expect(stdout).toContain(`Input does not meet YAML 1.2 "Core Schema" specification: ${name}`);
    });

    it('names server-url when it is missing', async () => {
      const { exitCode, stdout } = await runAction({ 'INPUT_SERVER-URL': '' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Input required and not supplied: server-url');
    });

    it('asks for the id-token permission when the runner gave no token vars', async () => {
      await startServer();
      const { exitCode, stdout } = await runAction(
        {},
        { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain('permissions: id-token: write');
    });
  });

  /** A listing and the files behind it, with correct digests, from a server a test controls. */
  const fakeListing = (files: Record<string, Uint8Array>) => {
    const artifacts = Object.entries(files).map(([name, content]) => ({
      id: 'a'.repeat(43),
      name,
      size: content.length,
      digest: sha256(content),
      expiresAt: '2030-01-01T00:00:00Z',
      links: { home: 'http://127.0.0.1:1/never' },
      repositoryId: '7',
      runId: '100',
      runAttempt: '1',
    }));
    return { artifacts, json: JSON.stringify({ artifacts }) };
  };

  const startFakeArtifacts = async (files: Record<string, Uint8Array>) => {
    const { json } = fakeListing(files);
    serverUrl = await runner.useFakeServer(
      createServer((req, res) => {
        if (req.url?.startsWith('/artifacts')) {
          return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
        }
        const content = files[req.url?.split('/').pop() ?? ''];
        if (content === undefined) return void res.writeHead(404).end('{"error":"Not found"}');
        return void res
          .writeHead(200, { 'Content-Length': content.length })
          .end(Buffer.from(content));
      }),
    );
  };

  describe('a zip, and what is already there', () => {
    it('refuses a symlink out of the destination before writing anything', async () => {
      await startServer();
      const destination = join(runner.rootDir, 'out');
      await mkdir(destination);
      await writeFile(join(destination, 'first.txt'), 'before');
      await symlink(tmpdir(), join(destination, 'link'));
      await storeZip('a.zip', { 'first.txt': 'after', 'link/evil.txt': 'blocked' });
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'a.zip',
        INPUT_PATH: destination,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('is a symlink leading out of');
      expect(await readFile(join(destination, 'first.txt'), 'utf8')).toBe('before');
    });

    it('fails on a file in the way of a folder, rather than succeeding around it', async () => {
      await startServer();
      const destination = join(runner.rootDir, 'out');
      await mkdir(destination);
      await writeFile(join(destination, 'sub'), 'a file');
      await storeZip('a.zip', { 'sub/a.txt': 'x' });
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'a.zip',
        INPUT_PATH: destination,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('sub is in the way of a folder');
      expect(await readFile(join(destination, 'sub'), 'utf8')).toBe('a file');
    });

    it('restores a file mode the umask would have cut down', async () => {
      await startServer();
      const source = join(runner.rootDir, 'source');
      await mkdir(source);
      await writeFile(join(source, 'shared.txt'), 'x');
      await chmod(join(source, 'shared.txt'), 0o664);
      await storeZipOfFile('a.zip', join(source, 'shared.txt'), source);
      const destination = join(runner.rootDir, 'out');
      const previous = process.umask(0o022);
      const result = await runAction({ INPUT_NAME: 'a.zip', INPUT_PATH: destination });
      process.umask(previous);
      expectSucceeded(result);
      expect((await stat(join(destination, 'shared.txt'))).mode & 0o777).toBe(0o664);
    });

    it("doesn't read a Windows zip's attributes as a Unix mode", async () => {
      const zip = zipSync({
        'unpinned.txt': [strToU8('x'), { os: 0, attrs: 0x00100020 }],
        'reparse.txt': [strToU8('y'), { os: 0, attrs: 0xa0000020 }],
      });
      await startFakeArtifacts({ 'a.zip': zip });
      const destination = join(runner.rootDir, 'out');
      expectSucceeded(await runAction({ INPUT_NAME: 'a.zip', INPUT_PATH: destination }));
      expect(await readFile(join(destination, 'unpinned.txt'), 'utf8')).toBe('x');
      expect(await readFile(join(destination, 'reparse.txt'), 'utf8')).toBe('y');
    });

    it('takes artifacts whose folders match but for case one at a time', async () => {
      await startServer();
      await storeZip('Build.zip', { 'a.txt': 'upper' });
      await storeZip('build.zip', { 'a.txt': 'lower' });
      const destination = join(runner.rootDir, 'out');
      expectSucceeded(await runAction({ INPUT_PATH: destination }));
    });

    it('refuses a path with a line break, which would add an output', async () => {
      await startServer();
      await storeZip('a.zip', { 'a.txt': 'x' });
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'a.zip',
        INPUT_PATH: `${join(runner.rootDir, 'out')}\ninjected=1`,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('path has a line break');
    });
  });

  describe('a malicious zip', () => {
    const outsideFile = () => join(runner.rootDir, 'evil.txt');

    const expectRefused = async (zip: Uint8Array, message: string | RegExp) => {
      await startFakeArtifacts({ 'evil.zip': zip });
      const { exitCode, stdout } = await runAction({ INPUT_NAME: 'evil', INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/^::error::Unable to download artifact\(s\): /m);
      expect(stdout).toMatch(message);
      expect(existsSync(outsideFile())).toBe(false);
      expect(await treeOf(destination)).toEqual({});
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    };

    it.each([
      ['a parent path', '../evil.txt'],
      ['a parent path further in', 'a/b/../../../evil.txt'],
      ['a backslash parent path', '..\\evil.txt'],
      ['a mixed parent path', 'a/..\\..\\evil.txt'],
    ])('with %s fails the step, writing nothing', async (_, path) => {
      await expectRefused(
        zipSync({ 'first.txt': strToU8('fine'), [path]: strToU8('evil') }),
        /invalid relative path/,
      );
    });

    it('with an absolute path fails the step, writing nothing', async () => {
      const path = join(runner.rootDir, 'evil.txt');
      await expectRefused(
        zipSync({ 'first.txt': strToU8('fine'), [path]: strToU8('evil') }),
        /absolute path/,
      );
    });

    it('with a drive path fails the step, writing nothing', async () => {
      await expectRefused(zipSync({ 'C:\\evil.txt': strToU8('evil') }), /absolute path/);
    });

    it('with a NUL in a path fails the step, writing nothing', async () => {
      await expectRefused(zipSync({ 'a\0.txt': strToU8('evil') }), /leads out of the destination/);
    });

    const symlinkAttributes = (0o120777 << 16) >>> 0;

    it('with a symlink out fails the step, making no link', async () => {
      await expectRefused(
        zipSync({
          'first.txt': strToU8('fine'),
          link: [strToU8(runner.rootDir), { os: 3, attrs: symlinkAttributes }],
        }),
        /"link" is a symlink/,
      );
      expect(existsSync(join(destination, 'link'))).toBe(false);
    });

    it('with a symlink to write through fails the step, writing nothing', async () => {
      await expectRefused(
        zipSync({
          link: [strToU8('..'), { os: 3, attrs: symlinkAttributes }],
          'link/evil.txt': strToU8('evil'),
        }),
        /"link" is a symlink/,
      );
    });

    it('with a symlink that stays inside fails too: one could be chained to lead out', async () => {
      await expectRefused(
        zipSync({
          'real.txt': strToU8('fine'),
          link: [strToU8('real.txt'), { os: 3, attrs: symlinkAttributes }],
        }),
        /"link" is a symlink/,
      );
    });

    it('that is no zip at all fails the step, and skip-decompress keeps it', async () => {
      await startFakeArtifacts({ 'broken.zip': strToU8('not a zip') });
      const refused = await runAction({ INPUT_NAME: 'broken', INPUT_PATH: destination });
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toContain("Can't place broken.zip");

      const kept = await runAction({
        INPUT_NAME: 'broken',
        'INPUT_SKIP-DECOMPRESS': 'true',
        INPUT_PATH: destination,
      });
      expectSucceeded(kept);
      expect(await treeOf(destination)).toEqual({ 'broken.zip': 'not a zip' });
    });

    describe('against what the destination already holds', () => {
      it('will not write through a symlink folder leading out', async () => {
        await startFakeArtifacts({
          'evil.zip': zipSync({ 'out/evil.txt': strToU8('evil') }),
        });
        await mkdir(destination);
        const outside = join(runner.rootDir, 'outside');
        await mkdir(outside);
        await symlink(outside, join(destination, 'out'));

        const { exitCode, stdout } = await runAction({
          INPUT_NAME: 'evil',
          INPUT_PATH: destination,
        });

        expect(exitCode).toBe(1);
        expect(stdout).toContain('out is a symlink leading out of');
        expect(await readdir(outside)).toEqual([]);
      });

      it('writes through a symlink folder that stays inside, as upstream would', async () => {
        await startFakeArtifacts({ 'a.zip': zipSync({ 'link/a.txt': strToU8('a') }) });
        await mkdir(join(destination, 'real'), { recursive: true });
        await symlink(join(destination, 'real'), join(destination, 'link'));

        expectSucceeded(await runAction({ INPUT_NAME: 'a', INPUT_PATH: destination }));

        expect(await readFile(join(destination, 'real/a.txt'), 'utf8')).toBe('a');
      });

      it('replaces rather than follows a symlink where a file goes', async () => {
        await startFakeArtifacts({ 'a.zip': zipSync({ 'a.txt': strToU8('a') }) });
        const outside = join(runner.rootDir, 'outside.txt');
        await writeFile(outside, 'untouched');
        await mkdir(destination);
        await symlink(outside, join(destination, 'a.txt'));

        expectSucceeded(await runAction({ INPUT_NAME: 'a', INPUT_PATH: destination }));

        expect(await readFile(outside, 'utf8')).toBe('untouched');
        expect(await readFile(join(destination, 'a.txt'), 'utf8')).toBe('a');
      });

      it('takes a path that is itself a symlink, as it means to', async () => {
        await startFakeArtifacts({ 'a.zip': zipSync({ 'a.txt': strToU8('a') }) });
        const real = join(runner.rootDir, 'real');
        await mkdir(real);
        await symlink(real, destination);

        expectSucceeded(await runAction({ INPUT_NAME: 'a', INPUT_PATH: destination }));

        expect(await treeOf(real)).toEqual({ 'a.txt': 'a' });
      });

      it("will not follow a symlink out in an artifact's own folder", async () => {
        const zip = zipSync({ 'a.txt': strToU8('a') });
        await startFakeArtifacts({ 'a.zip': zip, 'b.zip': zip });
        await mkdir(destination);
        const outside = join(runner.rootDir, 'outside');
        await mkdir(outside);
        await symlink(outside, join(destination, 'a'));

        const { exitCode, stdout } = await runAction({ INPUT_PATH: destination });

        expect(exitCode).toBe(1);
        expect(stdout).toContain('a is a symlink leading out of');
        expect(await readdir(outside)).toEqual([]);
      });
    });

    describe('as a zip bomb', () => {
      /** One kernel of data, with as many central directory entries pointing at it as asked. */
      const zipDeclaring = (content: Uint8Array, declaredSize: number, entries = 1) => {
        const compressed = deflateSync(content);
        const localName = strToU8('kernel');
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(8, 8, true);
        local.setUint32(18, compressed.length, true);
        local.setUint32(22, declaredSize, true);
        local.setUint16(26, localName.length, true);
        const directory = Array.from({ length: entries }, (_, index) => {
          const name = strToU8(`bomb-${index}.bin`);
          const central = new DataView(new ArrayBuffer(46));
          central.setUint32(0, 0x02014b50, true);
          central.setUint16(6, 20, true);
          central.setUint16(10, 8, true);
          central.setUint32(20, compressed.length, true);
          central.setUint32(24, declaredSize, true);
          central.setUint16(28, name.length, true);
          return Buffer.concat([new Uint8Array(central.buffer), name]);
        });
        const centralDirectory = Buffer.concat(directory);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries, true);
        end.setUint16(10, entries, true);
        end.setUint32(12, centralDirectory.length, true);
        end.setUint32(16, 30 + localName.length + compressed.length, true);
        return Buffer.concat([
          new Uint8Array(local.buffer),
          localName,
          compressed,
          centralDirectory,
          new Uint8Array(end.buffer),
        ]);
      };

      it('that declares more than the disk holds fails before writing anything', async () => {
        // Overlapping entries: 2,048 of them at nearly 4 GiB each, over one small kernel.
        await startFakeArtifacts({ 'bomb.zip': zipDeclaring(strToU8('x'), 0xfffffffe, 2048) });
        const { exitCode, stdout } = await runAction({
          INPUT_NAME: 'bomb',
          INPUT_PATH: destination,
        });
        expect(exitCode).toBe(1);
        expect(stdout).toContain(`would unpack to ${0xfffffffe * 2048} bytes`);
        expect(await treeOf(destination)).toEqual({});
        expect(await readdir(runner.runnerTemp)).toEqual([]);
      });

      it('that lies about its size stops at what it declared', async () => {
        const huge = new Uint8Array(64 * 1024 ** 2);
        await startFakeArtifacts({ 'bomb.zip': zipDeclaring(huge, 1024) });
        const { exitCode, stdout } = await runAction({
          INPUT_NAME: 'bomb',
          INPUT_PATH: destination,
        });
        expect(exitCode).toBe(1);
        expect(stdout).toMatch(/too many bytes in the stream/);
        const written = await stat(join(destination, 'bomb-0.bin')).catch(() => undefined);
        expect(written?.size ?? 0).toBeLessThanOrEqual(1024 + 64 * 1024);
      });
    });
  });

  describe('a server that misbehaves', () => {
    it.each([
      ['a name leading out', { name: '../../evil.zip' }],
      ['an ID with a path', { id: '../'.repeat(14).padEnd(43, 'a') }],
      ['a digest of the wrong shape', { digest: 'abc' }],
      ['a negative size', { size: -1 }],
    ])('is refused for %s, writing nothing', async (_, override) => {
      const { artifacts } = fakeListing({ 'a.zip': strToU8('x') });
      const json = JSON.stringify({ artifacts: [{ ...artifacts[0], ...override }] });
      serverUrl = await runner.useFakeServer(
        createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
        }),
      );
      const { exitCode, stdout } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('answered with an unusable artifact list');
      expect(existsSync(destination)).toBe(false);
    });

    it('is cut off once it sends more than it listed, and not retried', async () => {
      const { artifacts } = fakeListing({ 'a.bin': strToU8('short') });
      let fetches = 0;
      serverUrl = await runner.useFakeServer(
        createServer((req, res) => {
          if (req.url?.startsWith('/artifacts')) {
            return void res.end(JSON.stringify({ artifacts }));
          }
          fetches += 1;
          return void res.end('longer than it said it was');
        }),
      );
      const { exitCode, stdout } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('longer than the 5 bytes it was listed at');
      expect(fetches).toBe(1);
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('retries a body cut short, starting the file again', { timeout: 20_000 }, async () => {
      const content = strToU8('the whole of the file');
      const { artifacts } = fakeListing({ 'a.bin': content });
      let fetches = 0;
      serverUrl = await runner.useFakeServer(
        createServer((req, res) => {
          if (req.url?.startsWith('/artifacts')) {
            return void res.end(JSON.stringify({ artifacts }));
          }
          fetches += 1;
          res.writeHead(200, { 'Content-Length': content.length });
          if (fetches === 1) {
            return void res.write(Buffer.from(content.slice(0, 5)), () => res.destroy());
          }
          return void res.end(Buffer.from(content));
        }),
      );
      const result = await runAction({ INPUT_PATH: destination });
      expectSucceeded(result);
      expect(result.stderr).toContain('Attempt 1 failed');
      expect(fetches).toBe(2);
      expect(await treeOf(destination)).toEqual({ 'a.bin': 'the whole of the file' });
    });

    it('retries a 5xx on the list, with a fresh token, and says why it gave up', {
      timeout: 20_000,
    }, async () => {
      let requests = 0;
      const seen = new Set<string | undefined>();
      serverUrl = await runner.useFakeServer(
        createServer((req, res) => {
          requests += 1;
          seen.add(req.headers.authorization);
          res
            .writeHead(500, { 'Content-Type': 'application/json' })
            .end('{"error":"boom\\n::warning::injected"}');
        }),
      );
      const { exitCode, stdout, stderr } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(requests).toBe(4);
      expect(seen.size).toBeGreaterThanOrEqual(1);
      expect(stdout).toContain('::error::Unable to download artifact(s): boom');
      expect(stdout).not.toMatch(/^::warning::/m);
      expect(stderr).not.toMatch(/^::warning::/m);
    });

    it('fails at once on a 404 for a file that went after it was listed', async () => {
      const { artifacts } = fakeListing({ 'a.bin': strToU8('x') });
      serverUrl = await runner.useFakeServer(
        createServer((req, res) => {
          if (req.url?.startsWith('/artifacts')) {
            return void res.end(JSON.stringify({ artifacts }));
          }
          return void res.writeHead(404).end('{"error":"Not found"}');
        }),
      );
      const { exitCode, stdout } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Not found');
    });

    it('does not follow a redirect', { timeout: 20_000 }, async () => {
      serverUrl = await runner.useFakeServer(
        createServer((_req, res) => {
          res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }).end();
        }),
      );
      const { exitCode } = await runAction({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
    });
  });

  it('removes the temp file when the runner stops the step', async () => {
    const { promise: requested, resolve: onRequest } = Promise.withResolvers<void>();
    const content = strToU8('x'.repeat(1024));
    const { artifacts } = fakeListing({ 'a.bin': content });
    serverUrl = await runner.useFakeServer(
      createServer((req, res) => {
        if (req.url?.startsWith('/artifacts')) return void res.end(JSON.stringify({ artifacts }));
        res.writeHead(200, { 'Content-Length': content.length });
        res.write(Buffer.from(content.slice(0, 10)), () => onRequest());
        return undefined;
      }),
    );
    const child = spawn(ACTION_NODE, [ACTION], {
      cwd: runner.workDir,
      stdio: 'ignore',
      env: {
        ...runner.runnerEnv,
        'INPUT_SERVER-URL': serverUrl,
        INPUT_AUDIENCE: AUDIENCE,
        INPUT_PATH: destination,
      },
    });
    await requested;
    expect(await readdir(runner.runnerTemp)).toHaveLength(1);

    child.kill('SIGTERM');
    await once(child, 'exit');
    expect(await readdir(runner.runnerTemp)).toEqual([]);
  });

  /** Written by the upload's own zip code, so a round trip holds what the upload really produces. */
  const zipOfFile = async (source: string, rootDirectory: string, compressionLevel = 6) => {
    const zip = join(runner.rootDir, `${crypto.randomUUID()}.zip`);
    await Effect.runPromise(
      zipFiles({ files: [source], rootDirectory, compressionLevel, target: zip }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    return zip;
  };

  const storeZipOfFile = async (name: string, source: string, rootDirectory: string) =>
    store(`${name}.zip`, await readFile(await zipOfFile(source, rootDirectory)));

  describe('holds it out of memory', () => {
    const fileBytes = 512 * 1024 ** 2;

    const reportPeak = async () => {
      const reporter = join(runner.rootDir, 'report-peak-memory.mjs');
      await writeFile(reporter, PEAK_REPORTER);
      return { NODE_OPTIONS: `--import=${reporter}` };
    };

    const expectLowPeak = ({ stderr }: { stderr: string }) => {
      const peakBytes = Number(/peak-kib=(\d+)/.exec(stderr)?.[1]) * 1024;
      expect(peakBytes).toBeGreaterThan(0);
      expect(peakBytes).toBeLessThan(fileBytes / 2);
    };

    /** Sent from disk, as the real upload is: the test's own memory stays out of it. */
    const storeFromDisk = async (name: string, path: string) => {
      const response = await fetch(`${serverUrl}/artifacts?name=${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await runner.signToken()}` },
        body: await openAsBlob(path),
      });
      expect(response.status).toBe(201);
    };

    const makeSparseFile = async () => {
      const path = join(runner.rootDir, 'big.bin');
      await writeFile(path, '');
      await truncate(path, fileBytes);
      return path;
    };

    it.each([
      ['a file as it is', 'big.bin', undefined],
      ['a zip as big as the file', 'big.zip', 0],
      ['a compressed zip', 'big.zip', 6],
    ])('%s', { timeout: 120_000 }, async (_, name, compressionLevel) => {
      await startServer();
      const path = await makeSparseFile();
      await storeFromDisk(
        name,
        compressionLevel === undefined
          ? path
          : await zipOfFile(path, runner.rootDir, compressionLevel),
      );

      const result = await runAction(
        { INPUT_NAME: name === 'big.bin' ? 'big.bin' : 'big', INPUT_PATH: destination },
        await reportPeak(),
      );

      expectSucceeded(result);
      expectLowPeak(result);
      expect((await stat(join(destination, 'big.bin'))).size).toBe(fileBytes);
    });
  });

  describe('from the command line', () => {
    it('downloads, printing only JSON to stdout', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' });
      const missing = 'a'.repeat(43);
      const stored = await storeZip('other', { 'b.txt': 'b' });

      const { exitCode, stdout, stderr } = await runCli('download', [
        '--artifact-ids',
        `${stored.id},${missing}`,
        '--path',
        destination,
      ]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        downloadPath: destination,
        artifacts: [{ name: 'other.zip', id: stored.id }],
      });
      expect(stderr).toContain(`Warning: Could not find the following artifact IDs: ${missing}`);
      expect(await treeOf(destination)).toEqual({ 'b.txt': 'b' });
    });

    it('takes the same flags as the inputs', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': 'a' }, { run_id: '200' });
      const { exitCode } = await runCli('download', [
        '--name',
        'build',
        '--run-id',
        '200',
        '--skip-decompress',
        'true',
        '--merge-multiple',
        'true',
        '--digest-mismatch',
        'warn',
        '--github-token',
        'ignored',
        '--repository',
        'fishballapp/private-thing',
        '--path',
        destination,
      ]);
      expect(exitCode).toBe(0);
      expect(await readdir(destination)).toEqual(['build.zip']);
    });

    it('lists as JSON, with the latest attempt of each name', async () => {
      await startServer();
      await storeZip('build', { 'a.txt': '1' });
      const latest = await storeZip('build', { 'a.txt': '2' }, { run_attempt: '2' });
      await store('app.apk', strToU8('x'));

      const { exitCode, stdout } = await runCli('list', []);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        artifacts: [
          { name: 'app.apk', runAttempt: '1', repositoryId: '7', runId: '100' },
          { name: 'build.zip', id: latest.id, runAttempt: '2', digest: latest.digest },
        ],
      });
    });

    it('narrows a list as a download is, and reads elsewhere', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('other', { 'b.txt': 'b' });
      await storeZip(
        'there',
        { 'c.txt': 'c' },
        {
          repository: 'fishballapp/other',
          repository_id: '8',
          run_id: '200',
        },
      );
      const namesFrom = async (args: readonly string[]) =>
        JSON.parse((await runCli('list', args)).stdout).artifacts.map(
          ({ name }: { name: string }) => name,
        );
      expect(await namesFrom(['--pattern', 'build-*'])).toEqual(['build-a.zip']);
      expect(await namesFrom(['--name', 'other'])).toEqual(['other.zip']);
      expect(await namesFrom(['--repository', 'fishballapp/other', '--run-id', '200'])).toEqual([
        'there.zip',
      ]);
      expect(await namesFrom(['--run-id', '999'])).toEqual([]);
    });

    it('deletes by name in the current run, and the name is gone', async () => {
      await startServer();
      const { id } = await storeZip('build', { 'a.txt': 'a' });
      const elsewhere = await storeZip('build', { 'a.txt': 'b' }, { run_id: '200' });

      const { exitCode, stdout } = await runCli('delete', ['--name', 'build']);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ id, name: 'build.zip' });
      expect(JSON.parse((await runCli('list', [])).stdout).artifacts).toEqual([]);
      const there = JSON.parse((await runCli('list', ['--run-id', '200'])).stdout);
      expect(there.artifacts).toMatchObject([{ id: elsewhere.id }]);
    });

    it('deletes by ID in any run of its repository', async () => {
      await startServer();
      const { id } = await storeZip('build', { 'a.txt': 'a' }, { run_id: '200' });
      const { exitCode, stdout } = await runCli('delete', ['--artifact-id', id]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ id, name: 'build.zip' });
    });

    it("refuses another repository's artifact with the server's message", async () => {
      await startServer();
      const { id } = await storeZip(
        'build',
        { 'a.txt': 'a' },
        {
          repository: 'fishballapp/other',
          repository_id: '8',
        },
      );
      const { exitCode, stderr } = await runCli('delete', ['--artifact-id', id]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('A job can only delete artifacts of its own repository');
    });

    it.each([
      ['both', ['--name', 'a', '--artifact-id', 'a'.repeat(43)], 'Give one of --name'],
      ['neither', [], 'Give one of --name'],
      ['a bad ID', ['--artifact-id', 'nope'], "Invalid artifact ID: 'nope'"],
      ['a name that is not there', ['--name', 'nope'], "Artifact 'nope' not found"],
    ])('refuses to delete with %s', async (_, args, message) => {
      await startServer();
      const { exitCode, stderr } = await runCli('delete', args);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(message);
    });

    it('round-trips what the real upload command writes', async () => {
      await startServer();
      await mkdir(join(runner.workDir, 'dist/deep'), { recursive: true });
      await writeFile(join(runner.workDir, 'dist/deep/a.txt'), 'a');
      await writeFile(join(runner.workDir, 'dist/run.sh'), 'x');
      await chmod(join(runner.workDir, 'dist/run.sh'), 0o755);

      const uploaded = await runCli('upload', ['--path', 'dist', '--name', 'site']);
      expect(uploaded.exitCode).toBe(0);
      const { digest } = JSON.parse(uploaded.stdout);

      const { exitCode, stdout } = await runCli('download', [
        '--name',
        'site',
        '--path',
        destination,
      ]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).artifacts).toMatchObject([{ digest }]);
      expect(await treeOf(destination)).toEqual({ 'deep/a.txt': 'a', 'run.sh': 'x' });
      expect((await stat(join(destination, 'run.sh'))).mode & 0o777).toBe(0o755);
    });

    it('says outside a job that the server takes no request from it', async () => {
      const { exitCode, stderr } = await runner.runNode(
        process.execPath,
        [BIN, 'list', '--server-url', 'http://127.0.0.1:1'],
        { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('No OIDC token available');
    });
  });
});
