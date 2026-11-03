import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, openAsBlob } from 'node:fs';
import { mkdir, readdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MERGE_ACTION } from '../tsdown.config.ts';
import {
  AUDIENCE,
  buildBundle,
  closeServer,
  generateRunnerKeys,
  listenOnLoopback,
  PEAK_REPORTER,
  startRunner,
} from './action-harness.ts';
import { zipFiles } from './zip.ts';

const ACTION = new URL('../../../upload/merge/dist/action.mjs', import.meta.url).pathname;
const BIN = new URL('./bin.ts', import.meta.url).pathname;
// CI sets this to a Node 24 binary, as that is what the runner runs the action on.
const ACTION_NODE = process.env.ACTION_NODE ?? process.execPath;

const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

type Stored = { id: string; name: string; digest: string; size: number; expiresAt: string };

describe('merging', () => {
  let keys: CryptoKeyPair;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  let serverUrl: string;
  let ownServers: Server[];

  beforeAll(async () => {
    await buildBundle(MERGE_ACTION);
    keys = await generateRunnerKeys();
  }, 60_000);

  beforeEach(async () => {
    runner = await startRunner({ keys });
    serverUrl = '';
    ownServers = [];
  });

  afterEach(async () => {
    await Promise.all(ownServers.map(closeServer));
    await runner.stop();
  });

  const startServer = async () => {
    serverUrl = await runner.startArtifactServer();
  };

  const authorized = async () => ({ Authorization: `Bearer ${await runner.signToken()}` });

  /** Straight to the real server, as the job that uploaded would, with a real token. */
  const store = async (
    name: string,
    content: Uint8Array,
    run: Parameters<typeof runner.actAs>[0] = {},
  ): Promise<Stored> => {
    runner.actAs(run);
    const response = await fetch(`${serverUrl}/artifacts?name=${name}`, {
      method: 'POST',
      headers: await authorized(),
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

  /** What the run holds, latest attempt of each name. */
  const listRun = async (run: Parameters<typeof runner.actAs>[0] = {}) => {
    runner.actAs(run);
    const response = await fetch(`${serverUrl}/artifacts`, { headers: await authorized() });
    runner.actAs({});
    return ((await response.json()) as { artifacts: Stored[] }).artifacts;
  };

  const namesInRun = async (run: Parameters<typeof runner.actAs>[0] = {}) =>
    (await listRun(run)).map(({ name }) => name);

  const bytesOf = async ({ id, name }: Stored) =>
    new Uint8Array(await (await fetch(`${serverUrl}/${id}/${name}`)).arrayBuffer());

  /** The files of a stored zip, as `path: content`. */
  const filesOf = async (stored: Stored) =>
    Object.fromEntries(
      Object.entries(unzipSync(await bytesOf(stored)))
        .filter(([path]) => !path.endsWith('/'))
        .map(([path, content]) => [path, strFromU8(content)]),
    );

  const findInRun = async (name: string, run: Parameters<typeof runner.actAs>[0] = {}) => {
    const found = (await listRun(run)).find(artifact => artifact.name === name);
    if (found === undefined) throw new Error(`${name} is not in the run`);
    return found;
  };

  /** The files of the merged artifact of this name. */
  const merged = async (name = 'merged-artifacts', run: Parameters<typeof runner.actAs>[0] = {}) =>
    filesOf(await findInRun(`${name}.zip`, run));

  /**
   * A server in front of the real one, to refuse something the real one wouldn't. `refuse` answers
   * a request instead of passing it on.
   */
  const forwardingServer = async (
    refuse: (request: {
      method?: string;
      url?: string;
    }) => { status: number; body: string } | undefined,
  ) => {
    const realUrl = serverUrl;
    const proxy = createServer((req, res) => {
      void (async () => {
        const refusal = refuse(req);
        if (refusal !== undefined) {
          req.resume();
          return void res
            .writeHead(refusal.status, { 'Content-Type': 'application/json' })
            .end(refusal.body);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const answer = await fetch(`${realUrl}${req.url}`, {
          method: req.method,
          headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {},
          body: body.length > 0 ? body : undefined,
        });
        return void res
          .writeHead(answer.status, { 'Content-Type': answer.headers.get('content-type') ?? '' })
          .end(Buffer.from(await answer.arrayBuffer()));
      })();
    });
    ownServers.push(proxy);
    serverUrl = await listenOnLoopback(proxy);
    return { realUrl };
  };

  const statusOfLink = async (url: string | undefined) => (await fetch(url ?? '')).status;

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

  const runCli = (args: readonly string[]) =>
    runner.runNode(
      process.execPath,
      [BIN, 'merge', '--server-url', serverUrl, '--audience', AUDIENCE, ...args],
      {},
    );

  const expectSucceeded = ({ exitCode, stdout }: { exitCode: number; stdout: string }) => {
    expect(stdout).not.toContain('::error::');
    expect(exitCode).toBe(0);
  };

  const expectLeftNothingInTemp = async () => {
    expect(await readdir(runner.runnerTemp)).toEqual([]);
  };

  describe('with no inputs but the server', () => {
    it('merges every artifact of the run into `merged-artifacts`, and leaves them', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a', 'dir/b.txt': 'b' });
      await storeZip('build-b', { 'c.txt': 'c' });
      await store('app.apk', strToU8('an apk, not a zip'));

      const result = await runAction();

      expectSucceeded(result);
      expect(await merged()).toEqual({
        'a.txt': 'a',
        'dir/b.txt': 'b',
        'c.txt': 'c',
        'app.apk': 'an apk, not a zip',
      });
      expect((await namesInRun()).toSorted()).toEqual([
        'app.apk',
        'build-a.zip',
        'build-b.zip',
        'merged-artifacts.zip',
      ]);
      expect(result.stderr).toContain('Preparing to download the following artifacts:');
      expect(result.stderr).toContain('The 3 artifact(s) have been successfully merged!');
      await expectLeftNothingInTemp();
    });

    it('answers with the three outputs of upstream, and the links of the other actions', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });

      expectSucceeded(await runAction());

      const outputs = await runner.readOutputs();
      const stored = await findInRun('merged-artifacts.zip');
      expect(outputs['artifact-id']).toBe(stored.id);
      expect(outputs['artifact-url']).toBe(`http://127.0.0.1:1/${stored.id}/merged-artifacts.zip`);
      expect(outputs['artifact-digest']).toBe(sha256(await bytesOf(stored)));
      expect(JSON.parse(outputs.links ?? '')).toEqual({
        home: outputs['artifact-url'],
        tailscale: `https://files.example/${stored.id}/merged-artifacts.zip`,
      });
      expect(outputs['expires-at']).toBe(stored.expiresAt);
    });

    it('keeps the artifacts of other runs out of it', async () => {
      await startServer();
      await storeZip('mine', { 'a.txt': 'a' });
      await storeZip('theirs', { 'b.txt': 'b' }, { run_id: '200' });
      await storeZip('elsewhere', { 'c.txt': 'c' }, { repository_id: '8' });

      expectSucceeded(await runAction());

      expect(await merged()).toEqual({ 'a.txt': 'a' });
    });

    it('works in a temp folder whose name a glob would read', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      const odd = join(runner.rootDir, 'runner [temp] *?');
      await mkdir(odd);

      expectSucceeded(await runAction({}, { RUNNER_TEMP: odd }));

      expect(await merged()).toEqual({ 'a.txt': 'a' });
      expect(await readdir(odd)).toEqual([]);
    });

    it('fails without the id-token permission, before downloading anything', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      const { exitCode, stdout, stderr } = await runAction(
        {},
        { ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain('::error::No OIDC token available');
      expect(stderr).not.toContain('Preparing to download');
    });
  });

  describe('name', () => {
    it('stores the merged artifact as `<name>.zip`', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });

      expectSucceeded(await runAction({ INPUT_NAME: 'everything' }));

      expect(await merged('everything')).toEqual({ 'a.txt': 'a' });
      expect(await namesInRun()).not.toContain('merged-artifacts.zip');
    });

    it('takes the default for an empty one, as the runner passes an unset input', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      expectSucceeded(await runAction({ INPUT_NAME: '', INPUT_PATTERN: '' }));
      expect(await merged()).toEqual({ 'a.txt': 'a' });
    });

    it('refuses a name the server would, before downloading anything', async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      const { exitCode, stdout, stderr } = await runAction({ INPUT_NAME: 'no spaces' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('::error::name must match [A-Za-z0-9][A-Za-z0-9._-]{0,254}');
      expect(stderr).not.toContain('Preparing to download');
    });
  });

  describe('pattern', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
      await storeZip('other', { 'c.txt': 'c' });
    });

    it('merges only the names it matches, as a download would match them', async () => {
      expectSucceeded(await runAction({ INPUT_PATTERN: 'build-*' }));
      expect(await merged()).toEqual({ 'a.txt': 'a', 'b.txt': 'b' });
    });

    it('matches the name without `.zip`', async () => {
      expectSucceeded(await runAction({ INPUT_PATTERN: 'other' }));
      expect(await merged()).toEqual({ 'c.txt': 'c' });
    });

    it('fails when nothing matches, storing nothing', async () => {
      const { exitCode, stdout } = await runAction({ INPUT_PATTERN: 'nope-*' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("::error::No artifacts found matching pattern 'nope-*'");
      expect(await namesInRun()).toEqual(['build-a.zip', 'build-b.zip', 'other.zip']);
      expect(existsSync(runner.outputPath)).toBe(false);
      await expectLeftNothingInTemp();
    });
  });

  describe('separate-directories', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a', 'both.txt': 'from a' });
      await storeZip('build-b', { 'dir/b.txt': 'b', 'both.txt': 'from b' });
    });

    it('false puts them in one folder, the last by name winning a shared path', async () => {
      expectSucceeded(await runAction({ 'INPUT_SEPARATE-DIRECTORIES': 'false' }));
      expect(await merged()).toEqual({
        'a.txt': 'a',
        'dir/b.txt': 'b',
        'both.txt': 'from b',
      });
    });

    it('true puts each in a folder of its name', async () => {
      expectSucceeded(await runAction({ 'INPUT_SEPARATE-DIRECTORIES': 'true' }));
      expect(await merged()).toEqual({
        'build-a/a.txt': 'a',
        'build-a/both.txt': 'from a',
        'build-b/dir/b.txt': 'b',
        'build-b/both.txt': 'from b',
      });
    });

    it('true keeps the folder when only one artifact matches', async () => {
      expectSucceeded(
        await runAction({ 'INPUT_SEPARATE-DIRECTORIES': 'true', INPUT_PATTERN: 'build-a' }),
      );
      expect(await merged()).toEqual({ 'build-a/a.txt': 'a', 'build-a/both.txt': 'from a' });
    });

    it('true puts a file uploaded as it is in a folder of its own name', async () => {
      await store('app.apk', strToU8('apk'));
      expectSucceeded(await runAction({ 'INPUT_SEPARATE-DIRECTORIES': 'true' }));
      expect((await merged())['app.apk/app.apk']).toBe('apk');
    });

    it('reads anything but a boolean as a failure', async () => {
      const { exitCode, stdout, stderr } = await runAction({ 'INPUT_SEPARATE-DIRECTORIES': 'yes' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('separate-directories');
      expect(stderr).not.toContain('Preparing to download');
    });
  });

  describe('retention-days and compression-level', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'compressible '.repeat(20_000) });
    });

    const daysUntil = (expiresAt: string | undefined) =>
      (Date.parse(expiresAt ?? '') - Date.now()) / 86_400_000;

    it("keeps for the server's default without it, and for the days asked with it", async () => {
      expectSucceeded(await runAction({ INPUT_NAME: 'by-default' }));
      expect(daysUntil((await runner.readOutputs())['expires-at'])).toBeCloseTo(7, 1);

      await writeFile(runner.outputPath, '');
      expectSucceeded(await runAction({ INPUT_NAME: 'for-three', 'INPUT_RETENTION-DAYS': '3' }));
      expect(daysUntil((await runner.readOutputs())['expires-at'])).toBeCloseTo(3, 1);
    });

    it('compresses at the level asked for', async () => {
      expectSucceeded(await runAction({ INPUT_NAME: 'none', 'INPUT_COMPRESSION-LEVEL': '0' }));
      expectSucceeded(await runAction({ INPUT_NAME: 'best', 'INPUT_COMPRESSION-LEVEL': '9' }));
      const sizes = Object.fromEntries((await listRun()).map(({ name, size }) => [name, size]));
      expect(sizes['none.zip']).toBeGreaterThan(260_000);
      expect(sizes['best.zip']).toBeLessThan(5_000);
    });

    it.each([
      ['retention-days', 'soon', 'Invalid retention-days'],
      ['compression-level', '10', 'Invalid compression-level. Valid values are 0-9'],
      ['compression-level', 'x', 'Invalid compression-level'],
      ['include-hidden-files', 'perhaps', 'include-hidden-files'],
      ['delete-merged', 'perhaps', 'delete-merged'],
    ])('fails on a bad %s of %s before downloading anything', async (input, value, message) => {
      const { exitCode, stdout, stderr } = await runAction({
        [`INPUT_${input.toUpperCase()}`]: value,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(`::error::`);
      expect(stdout).toContain(message);
      expect(stderr).not.toContain('Preparing to download');
      expect(await namesInRun()).toEqual(['build-a.zip']);
    });
  });

  describe('include-hidden-files', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', {
        'index.html': 'i',
        '.env': 'secret',
        '.cache/data': 'c',
        'sub/.hidden': 'h',
      });
    });

    it('leaves hidden files and folders out by default', async () => {
      expectSucceeded(await runAction());
      expect(await merged()).toEqual({ 'index.html': 'i' });
    });

    it('keeps them when asked', async () => {
      expectSucceeded(await runAction({ 'INPUT_INCLUDE-HIDDEN-FILES': 'true' }));
      expect(await merged()).toEqual({
        'index.html': 'i',
        '.env': 'secret',
        '.cache/data': 'c',
        'sub/.hidden': 'h',
      });
    });

    it('fails when every file is hidden, as upstream does with nothing to upload', async () => {
      await storeZip('only-hidden', { '.env': 'secret' });
      const { exitCode, stdout } = await runAction({ INPUT_PATTERN: 'only-hidden' });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        "::error::No files were found in the artifacts matching pattern 'only-hidden'. Nothing was merged.",
      );
      expect(await namesInRun()).not.toContain('merged-artifacts.zip');
      await expectLeftNothingInTemp();
    });
  });

  describe('delete-merged', () => {
    beforeEach(async () => {
      await startServer();
    });

    it('false leaves the originals, and their links', async () => {
      const a = await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
      expectSucceeded(await runAction({ 'INPUT_DELETE-MERGED': 'false' }));
      expect(await namesInRun()).toContain('build-a.zip');
      expect(await statusOfLink(`${serverUrl}/${a.id}/build-a.zip`)).toBe(200);
    });

    it('true deletes them once merged, and only them', async () => {
      const a = await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
      await storeZip('other', { 'c.txt': 'c' });
      const kept = await storeZip('theirs', { 'd.txt': 'd' }, { run_id: '200' });

      const result = await runAction({ 'INPUT_DELETE-MERGED': 'true', INPUT_PATTERN: 'build-*' });

      expectSucceeded(result);
      expect((await namesInRun()).toSorted()).toEqual(['merged-artifacts.zip', 'other.zip']);
      expect(await merged()).toEqual({ 'a.txt': 'a', 'b.txt': 'b' });
      expect(await statusOfLink(`${serverUrl}/${a.id}/build-a.zip`)).toBe(404);
      expect(await statusOfLink(`${serverUrl}/${kept.id}/theirs.zip`)).toBe(200);
      expect(result.stderr).toContain('The 2 artifact(s) have been deleted');
    });

    it('true leaves the originals when the merged artifact is refused', async () => {
      await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
      // Other content under the name, in this attempt: the server refuses a second.
      await storeZip('merged-artifacts', { 'else.txt': 'else' });

      const result = await runAction({ 'INPUT_DELETE-MERGED': 'true' });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('already exists on the workflow run');
      expect((await namesInRun()).toSorted()).toEqual([
        'build-a.zip',
        'build-b.zip',
        'merged-artifacts.zip',
      ]);
      expect(await merged()).toEqual({ 'else.txt': 'else' });
      expect(existsSync(runner.outputPath)).toBe(false);
      await expectLeftNothingInTemp();
    });

    it('true leaves the originals when the server answers the upload with anything else', async () => {
      await storeZip('build-a', { 'a.txt': 'a' });
      await forwardingServer(({ method, url }) =>
        method === 'POST' && url?.startsWith('/artifacts')
          ? { status: 403, body: '{"error":"no uploads today"}' }
          : undefined,
      );

      const result = await runAction({ 'INPUT_DELETE-MERGED': 'true' });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('::error::no uploads today');
      expect(await namesInRun()).toEqual(['build-a.zip']);
    });

    it('true leaves the originals when one is not what the server stored', async () => {
      const a = await store(
        'build-a.zip',
        zipSync({ 'a.txt': strToU8('corrupt me, please') }, { level: 0 }),
      );
      await storeZip('build-b', { 'b.txt': 'b' });
      const dataFile = join(runner.storeDir, 'artifacts', a.id, 'data');
      const bytes = await readFile(dataFile);
      bytes.writeUInt8(
        bytes.readUInt8(bytes.indexOf('corrupt me')) ^ 0xff,
        bytes.indexOf('corrupt me'),
      );
      await writeFile(dataFile, bytes);

      const result = await runAction({ 'INPUT_DELETE-MERGED': 'true' });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        '::error::Digest validation failed for artifact(s): build-a.zip. Nothing was merged.',
      );
      expect((await namesInRun()).toSorted()).toEqual(['build-a.zip', 'build-b.zip']);
      await expectLeftNothingInTemp();
    });

    it('true fails the step when a delete is refused, after the merge is stored and its outputs written', async () => {
      const a = await storeZip('build-a', { 'a.txt': 'a' });
      const b = await storeZip('build-b', { 'b.txt': 'b' });
      await forwardingServer(({ method, url }) =>
        method === 'DELETE' && url?.endsWith(b.id)
          ? { status: 403, body: '{"error":"not yours"}' }
          : undefined,
      );

      const result = await runAction({ 'INPUT_DELETE-MERGED': 'true' });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "::error::Merged into merged-artifacts.zip, but couldn't delete: build-b.zip (not yours)",
      );
      expect(await merged()).toEqual({ 'a.txt': 'a', 'b.txt': 'b' });
      expect((await runner.readOutputs())['artifact-id']).toBeTruthy();
      // Each is tried, so one refusal doesn't keep the rest.
      expect((await namesInRun()).toSorted()).toEqual(['build-b.zip', 'merged-artifacts.zip']);
      expect(await statusOfLink(`${serverUrl}/${a.id}/build-a.zip`)).toBe(404);
    });
  });

  describe('merging again', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
    });

    it('in a re-run, starts afresh: it neither merges nor deletes the attempt before its result', async () => {
      expectSucceeded(await runAction());
      const first = await findInRun('merged-artifacts.zip');
      await writeFile(runner.outputPath, '');

      runner.actAs({ run_attempt: '2' });
      const rerun = await runAction({ 'INPUT_DELETE-MERGED': 'true', INPUT_PATTERN: '*' });
      runner.actAs({});

      expectSucceeded(rerun);
      const outputs = await runner.readOutputs();
      expect(outputs['artifact-id']).not.toBe(first.id);
      // Two files, not four: the first attempt's result wasn't one of its inputs.
      expect(await merged('merged-artifacts', { run_attempt: '2' })).toEqual({
        'a.txt': 'a',
        'b.txt': 'b',
      });
      expect(rerun.stderr).toContain('The 2 artifact(s) have been successfully merged!');
      expect(await namesInRun({ run_attempt: '2' })).toEqual(['merged-artifacts.zip']);
      // Nor was the first attempt's deleted, as a later attempt only replaces what it uploads.
      expect(await statusOfLink(`${serverUrl}/${first.id}/merged-artifacts.zip`)).toBe(200);
      expect(
        await statusOfLink(`${serverUrl}/${outputs['artifact-id']}/merged-artifacts.zip`),
      ).toBe(200);
    });

    it('in a re-run, leaves out the first attempt result whatever the pattern', async () => {
      expectSucceeded(await runAction({ INPUT_NAME: 'build-all' }));
      runner.actAs({ run_attempt: '2' });
      const rerun = await runAction({ INPUT_NAME: 'build-all', INPUT_PATTERN: 'build-*' });
      runner.actAs({});
      expectSucceeded(rerun);
      expect(rerun.stderr).toContain('The 2 artifact(s) have been successfully merged!');
    });

    it('never merges the artifact it is storing, whatever the pattern says', async () => {
      expectSucceeded(await runAction({ INPUT_PATTERN: 'build-a' }));
      const { exitCode, stdout } = await runAction({
        INPUT_NAME: 'build-a',
        INPUT_PATTERN: 'build-a',
      });
      // The name `build-a.zip` is both the only match and the result's, so there was nothing to merge.
      expect(exitCode).toBe(1);
      expect(stdout).toContain("No artifacts found matching pattern 'build-a'");
    });

    it('in the same attempt, succeeds with the artifact already there, as the same files make the same zip', async () => {
      expectSucceeded(await runAction());
      const first = await runner.readOutputs();
      await writeFile(runner.outputPath, '');

      // A step run twice, or retried by a wrapper, much later than the first.
      await new Promise(resolve => setTimeout(resolve, 2_500));
      expectSucceeded(await runAction());

      expect(await runner.readOutputs()).toEqual(first);
      expect((await namesInRun()).filter(name => name === 'merged-artifacts.zip')).toHaveLength(1);
    });

    it('in the same attempt, after a merge that stored but could not delete, finishes the delete', async () => {
      const b = await findInRun('build-b.zip');
      const { realUrl } = await forwardingServer(({ method }) =>
        method === 'DELETE' ? { status: 403, body: '{"error":"not today"}' } : undefined,
      );
      expect((await runAction({ 'INPUT_DELETE-MERGED': 'true' })).exitCode).toBe(1);
      expect(await namesInRun()).toHaveLength(3);

      serverUrl = realUrl;
      expectSucceeded(await runAction({ 'INPUT_DELETE-MERGED': 'true' }));

      expect(await namesInRun()).toEqual(['merged-artifacts.zip']);
      expect(await statusOfLink(`${serverUrl}/${b.id}/build-b.zip`)).toBe(404);
    });

    it('in the same attempt, fails on other content under the name, as uploading it would', async () => {
      expectSucceeded(await runAction());
      await storeZip('build-c', { 'c.txt': 'c' });

      const { exitCode, stdout } = await runAction({ 'INPUT_DELETE-MERGED': 'true' });

      expect(exitCode).toBe(1);
      expect(stdout).toContain('already exists on the workflow run');
      expect(await namesInRun()).toContain('build-c.zip');
    });
  });

  describe('from the command line', () => {
    beforeEach(async () => {
      await startServer();
      await storeZip('build-a', { 'a.txt': 'a' });
      await storeZip('build-b', { 'b.txt': 'b' });
      await storeZip('other', { 'c.txt': 'c' });
    });

    it('merges, printing only JSON to stdout', async () => {
      const { exitCode, stdout, stderr } = await runCli([]);

      expect(exitCode).toBe(0);
      const printed = JSON.parse(stdout);
      const stored = await findInRun('merged-artifacts.zip');
      expect(printed).toMatchObject({
        id: stored.id,
        name: 'merged-artifacts.zip',
        digest: stored.digest,
        size: stored.size,
        merged: [{ name: 'build-a.zip' }, { name: 'build-b.zip' }, { name: 'other.zip' }],
      });
      expect(printed.links.home).toBe(`http://127.0.0.1:1/${printed.id}/merged-artifacts.zip`);
      expect(stderr).toContain('The 3 artifact(s) have been successfully merged!');
    });

    it('takes the same flags as the inputs', async () => {
      const { exitCode } = await runCli([
        '--name',
        'builds',
        '--pattern',
        'build-*',
        '--separate-directories',
        'true',
        '--retention-days',
        '3',
        '--compression-level',
        '0',
        '--delete-merged',
        'true',
        '--include-hidden-files',
        'true',
      ]);

      expect(exitCode).toBe(0);
      expect(await merged('builds')).toEqual({ 'build-a/a.txt': 'a', 'build-b/b.txt': 'b' });
      expect((await namesInRun()).toSorted()).toEqual(['builds.zip', 'other.zip']);
    });

    it('fails with the message on stderr and nothing on stdout', async () => {
      const { exitCode, stdout, stderr } = await runCli(['--pattern', 'nope']);
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain("No artifacts found matching pattern 'nope'");
    });

    it('prints the result even when a delete then fails', async () => {
      await forwardingServer(({ method }) =>
        method === 'DELETE' ? { status: 403, body: '{"error":"nope"}' } : undefined,
      );
      const { exitCode, stdout, stderr } = await runCli(['--delete-merged', 'true']);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout).name).toBe('merged-artifacts.zip');
      expect(stderr).toContain("couldn't delete");
    });
  });

  it('removes what it unpacked when the runner stops the step', async () => {
    const { promise: requested, resolve: onRequest } = Promise.withResolvers<void>();
    const content = strToU8('x'.repeat(1024));
    const listing = JSON.stringify({
      artifacts: [
        {
          id: 'a'.repeat(43),
          name: 'a.bin',
          size: content.length,
          digest: sha256(content),
          expiresAt: '2030-01-01T00:00:00Z',
          links: { home: 'http://127.0.0.1:1/never' },
          repositoryId: '7',
          runId: '100',
          runAttempt: '1',
        },
      ],
    });
    serverUrl = await runner.useFakeServer(
      createServer((req, res) => {
        if (req.url?.startsWith('/artifacts')) return void res.end(listing);
        res.writeHead(200, { 'Content-Length': content.length });
        res.write(Buffer.from(content.slice(0, 10)), () => onRequest());
        return undefined;
      }),
    );
    const child = spawn(ACTION_NODE, [ACTION], {
      cwd: runner.workDir,
      stdio: 'ignore',
      env: { ...runner.runnerEnv, 'INPUT_SERVER-URL': serverUrl, INPUT_AUDIENCE: AUDIENCE },
    });
    await requested;
    expect(await readdir(runner.runnerTemp)).not.toEqual([]);

    child.kill('SIGTERM');
    await once(child, 'exit');
    await expectLeftNothingInTemp();
  });

  describe('holds it out of memory', () => {
    const fileBytes = 512 * 1024 ** 2;

    /** Written by the upload's own zip code, so it holds what an upload really produces. */
    const zipOfSparseFile = async (name: string, bytes: number, compressionLevel: number) => {
      const source = join(runner.rootDir, `${name}.bin`);
      await writeFile(source, '');
      await truncate(source, bytes);
      const zip = join(runner.rootDir, `${name}.zip`);
      await Effect.runPromise(
        zipFiles({
          files: [source],
          rootDirectory: runner.rootDir,
          compressionLevel,
          target: zip,
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      return zip;
    };

    /** Sent from disk, as the real upload is: the test's own memory stays out of it. */
    const storeFromDisk = async (name: string, path: string) => {
      const response = await fetch(`${serverUrl}/artifacts?name=${name}`, {
        method: 'POST',
        headers: await authorized(),
        body: await openAsBlob(path),
      });
      expect(response.status).toBe(201);
    };

    it.each([
      ['level 0', 0],
      ['level 6', 6],
    ])(
      'merging %s: half a gigabyte, twice over, stays under half of it',
      {
        timeout: 180_000,
      },
      async (_, compressionLevel) => {
        await startServer();
        await storeFromDisk('big-a.zip', await zipOfSparseFile('big-a', fileBytes / 2, 0));
        await storeFromDisk('big-b.zip', await zipOfSparseFile('big-b', fileBytes / 2, 6));
        const reporter = join(runner.rootDir, 'report-peak-memory.mjs');
        await writeFile(reporter, PEAK_REPORTER);

        const result = await runAction(
          { 'INPUT_COMPRESSION-LEVEL': String(compressionLevel), 'INPUT_DELETE-MERGED': 'true' },
          { NODE_OPTIONS: `--import=${reporter}` },
        );

        expectSucceeded(result);
        const peakBytes = Number(/peak-kib=(\d+)/.exec(result.stderr)?.[1]) * 1024;
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(fileBytes / 2);
        expect(await namesInRun()).toEqual(['merged-artifacts.zip']);
        await expectLeftNothingInTemp();
      },
    );
  });
});
