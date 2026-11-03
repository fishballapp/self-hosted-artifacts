import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_ACTION, UPLOAD_ACTION } from '../tsdown.config.ts';
import {
  buildBundle,
  generateRunnerKeys,
  PEAK_REPORTER,
  removeBundle,
  startRunner,
} from './action-harness.ts';
import { s3AddressOf } from './s3-client.ts';

// What only a bucket does. What it shares with a server is in the suites that run against both.

let UPLOAD: string;
let DOWNLOAD: string;
const BIN = new URL('./bin.ts', import.meta.url).pathname;
// CI sets this to a Node 24 binary, as that is what the runner runs the action on.
const ACTION_NODE = process.env.ACTION_NODE ?? process.execPath;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('addressing', () => {
  it('is virtual-hosted on AWS', () => {
    expect(
      s3AddressOf({
        bucket: 'builds',
        region: 'eu-west-2',
        endpoint: '',
        key: 'artifacts/a/b.zip',
      }),
    ).toEqual({
      origin: 'https://builds.s3.eu-west-2.amazonaws.com',
      host: 'builds.s3.eu-west-2.amazonaws.com',
      path: '/artifacts/a/b.zip',
    });
  });

  it('is path-style with an endpoint', () => {
    expect(
      s3AddressOf({
        bucket: 'builds',
        region: 'auto',
        endpoint: 'https://acct.r2.cloudflarestorage.com/',
        key: 'artifacts/a/b.zip',
      }),
    ).toEqual({
      origin: 'https://acct.r2.cloudflarestorage.com',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/builds/artifacts/a/b.zip',
    });
  });
});

describe('a bucket as the target', () => {
  let keys: CryptoKeyPair;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  let target: Awaited<ReturnType<typeof runner.startS3Target>>;

  beforeAll(async () => {
    [UPLOAD, DOWNLOAD] = await Promise.all([
      buildBundle(UPLOAD_ACTION),
      buildBundle(DOWNLOAD_ACTION),
    ]);
    keys = await generateRunnerKeys();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([UPLOAD, DOWNLOAD].map(removeBundle));
  });

  beforeEach(async () => {
    runner = await startRunner({ keys });
    target = await runner.startS3Target();
  });

  afterEach(async () => {
    await runner.stop();
  });

  const runUpload = (
    inputs: Record<string, string | undefined>,
    env: Record<string, string | undefined> = {},
  ) =>
    runner.runNode(ACTION_NODE, [UPLOAD], {
      ...target.inputs(),
      ...target.env(),
      ...inputs,
      ...env,
    });

  const runDownload = (
    inputs: Record<string, string | undefined>,
    env: Record<string, string | undefined> = {},
  ) =>
    runner.runNode(ACTION_NODE, [DOWNLOAD], {
      ...target.inputs(),
      ...target.env(),
      ...inputs,
      ...env,
    });

  const runCli = (args: readonly string[], env: Record<string, string | undefined> = {}) =>
    runner.runNode(process.execPath, [BIN, ...args], { ...target.env(), ...env });

  const OUTSIDE_ACTIONS = {
    GITHUB_REPOSITORY: undefined,
    GITHUB_REPOSITORY_ID: undefined,
    GITHUB_RUN_ID: undefined,
    GITHUB_RUN_ATTEMPT: undefined,
  };

  const uploadText = async (
    text: string,
    inputs: Record<string, string> = {},
    env: Record<string, string | undefined> = {},
  ) => {
    await writeFile(join(runner.workDir, 'app.bin'), text);
    await writeFile(runner.outputPath, '');
    const result = await runUpload(
      { INPUT_PATH: 'app.bin', INPUT_ARCHIVE: 'false', ...inputs },
      env,
    );
    return {
      ...result,
      outputs: result.exitCode === 0 ? await runner.readOutputs() : {},
    };
  };

  const statusOf = async (url: string | undefined) => (await fetch(url ?? '')).status;

  /** The scope's key for a name, as the job in `CURRENT_RUN` writes it. */
  const nameKeyOf = (name: string, attempt = '1') => `runs/7/100/${attempt}/${sha256(name)}.json`;

  const readJson = async (key: string) => (await target.raw.send('GET', key)).json();

  /** Moves a stored artifact's expiry into the past, behind the client's back. */
  const expire = async (key: string) => {
    const file = (await readJson(key)) as Record<string, unknown>;
    const response = await target.raw.send('PUT', key, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...file, expiresAt: '2020-01-01T00:00:00.000Z' }),
    });
    expect(response.ok).toBe(true);
    return file as { id: string; name: string };
  };

  describe('choosing it', () => {
    it.each([
      ['neither', { 'INPUT_S3-BUCKET': '' }, 'Give exactly one of server-url and s3-bucket'],
      [
        'both',
        { 'INPUT_SERVER-URL': 'http://127.0.0.1:1' },
        'Give exactly one of server-url and s3-bucket',
      ],
      ['no link base', { 'INPUT_S3-LINK-BASE': '' }, 's3-link-base is required with s3-bucket'],
      [
        'a link base with a query',
        { 'INPUT_S3-LINK-BASE': 'https://files.example/?a=b' },
        's3-link-base must be an http or https URL',
      ],
      [
        'an endpoint that is no URL',
        { 'INPUT_S3-ENDPOINT': 'not a url' },
        's3-endpoint must be an http or https URL',
      ],
      ['a bucket that is no name', { 'INPUT_S3-BUCKET': 'a/b' }, "Invalid s3-bucket: 'a/b'"],
    ])('refuses %s', async (_, inputs, message) => {
      const { exitCode, stdout } = await runUpload({ INPUT_PATH: 'nope', ...inputs });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(message);
    });

    it("refuses an S3 input with a server's URL", async () => {
      const { exitCode, stdout } = await runUpload({
        'INPUT_S3-BUCKET': '',
        'INPUT_S3-LINK-BASE': 'https://files.example',
        'INPUT_S3-REGION': '',
        'INPUT_S3-ENDPOINT': '',
        'INPUT_SERVER-URL': 'http://127.0.0.1:1',
        INPUT_PATH: 'nope',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('s3-link-base only go with s3-bucket');
    });

    it.each([
      ['credentials', { AWS_ACCESS_KEY_ID: undefined }, 'No S3 credentials'],
      ['credentials, passed as empty', { AWS_SECRET_ACCESS_KEY: '' }, 'No S3 credentials'],
      ['a region', { 'INPUT_S3-REGION': '', AWS_REGION: undefined }, 'No S3 region'],
      ['a run', OUTSIDE_ACTIONS, 'No run to work in'],
    ])('fails before the zip with no %s', async (_, env, message) => {
      await writeFile(join(runner.workDir, 'a.txt'), 'a');
      const { exitCode, stdout } = await runUpload({ INPUT_PATH: 'a.txt' }, env);
      expect(exitCode).toBe(1);
      expect(stdout).toContain(message);
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('takes the region from AWS_REGION', async () => {
      const { exitCode } = await uploadText(
        'x',
        { 'INPUT_S3-REGION': '' },
        { AWS_REGION: 'us-east-1' },
      );
      expect(exitCode).toBe(0);
    });

    it('still warns and succeeds with nothing to upload, with no credentials', async () => {
      const { exitCode, stdout } = await runUpload(
        { INPUT_PATH: 'nope' },
        { AWS_ACCESS_KEY_ID: undefined },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('::warning::No files were found');
    });

    it('asks for no token, and no id-token permission', async () => {
      const { exitCode } = await uploadText(
        'x',
        {},
        { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
      );
      expect(exitCode).toBe(0);
      expect(runner.tokenRequests).toEqual([]);
    });
  });

  describe('what it writes', () => {
    it('lays out the data, the name and the repository, as documented', async () => {
      const { outputs } = await uploadText('the build');
      const id = outputs['artifact-id'] ?? '';
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(outputs['artifact-url']).toBe(`${target.linkBase}/artifacts/${id}/app.bin`);
      expect((await target.raw.keys()).toSorted()).toEqual(
        [
          `artifacts/${id}/app.bin`,
          nameKeyOf('app.bin'),
          `repositories/${sha256('fishballapp/private-thing')}.json`,
        ].toSorted(),
      );
      expect(await readJson(nameKeyOf('app.bin'))).toEqual({
        id,
        name: 'app.bin',
        size: 9,
        digest: sha256('the build'),
        expiresAt: outputs['expires-at'],
        repositoryId: '7',
        runId: '100',
        runAttempt: '1',
      });
      expect(await readJson(`repositories/${sha256('fishballapp/private-thing')}.json`)).toEqual({
        name: 'fishballapp/private-thing',
        repositoryId: '7',
      });
    });

    it('serves a link anonymously, as an attachment', async () => {
      const { outputs } = await uploadText('the build');
      const response = await fetch(outputs['artifact-url'] ?? '');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition')).toBe('attachment');
      expect(await response.text()).toBe('the build');
    });

    it('keeps the name, the repository and the listing away from anyone with no key', async () => {
      await uploadText('the build');
      const base = target.linkBase;
      expect(await statusOf(`${base}/${nameKeyOf('app.bin')}`)).toBe(403);
      expect(
        await statusOf(`${base}/repositories/${sha256('fishballapp/private-thing')}.json`),
      ).toBe(403);
      expect(await statusOf(`${base}/?list-type=2`)).toBe(403);
      expect(await statusOf(`${base}/?list-type=2&prefix=artifacts/`)).toBe(403);
    });

    it('never prints a credential, even when a request is refused', async () => {
      const secret = 'a-wrong-secret-access-key';
      const refused = await uploadText('x', {}, { AWS_SECRET_ACCESS_KEY: secret });
      expect(refused.exitCode).toBe(1);
      const printed = `${refused.stdout}${refused.stderr}`;
      expect(printed).toMatch(/S3 refused to .*SignatureDoesNotMatch/);
      expect(printed).not.toContain(secret);
      expect(printed).not.toContain(target.env().AWS_ACCESS_KEY_ID);
      expect(printed).not.toContain('StringToSign');
      // A refusal isn't worth a retry.
      expect(printed).not.toContain('Attempt 1 failed');
    });

    it.runIf(process.env.S3_TEST_ENDPOINT === undefined)(
      'signs a session token, and keeps it from the log',
      async () => {
        const token = 'a-session-token';
        const { exitCode, stdout, stderr } = await uploadText(
          'x',
          {},
          { AWS_SESSION_TOKEN: token },
        );
        expect(exitCode).toBe(0);
        expect(`${stdout}${stderr}`).not.toContain(token);
      },
    );
  });

  describe('verifying what goes up', () => {
    it('refuses a body that is not its digest, and commits nothing', async () => {
      await expect(
        target.asJob(
          job =>
            job.send({
              file: new Blob(['not this']),
              name: 'app.bin',
              digest: sha256('this'),
              overwrite: false,
              retentionDays: 0,
            }),
          {},
        ),
      ).rejects.toThrow(/S3 refused to store app\.bin/);
      expect(await target.raw.keys('runs/')).toEqual([]);
    });
  });

  describe('where a request goes', () => {
    it('signs the host and the path as they are sent', () => {
      expect(
        s3AddressOf({ bucket: 'MyBucket', region: 'EU-West-2', endpoint: '', key: 'a' }).host,
      ).toBe('mybucket.s3.eu-west-2.amazonaws.com');
      expect(
        s3AddressOf({
          bucket: 'b',
          region: 'auto',
          endpoint: 'https://proxy.example/s3%20gateway/',
          key: 'a',
        }).path,
      ).toBe('/s3 gateway/b/a');
    });

    it.each([
      ['a bucket of dots', { '--s3-bucket': '..' }, 'Invalid s3-bucket'],
      ['an endpoint no URL can be', { '--s3-endpoint': 'https://[' }, 's3-endpoint must be'],
      [
        'an endpoint with a bad escape',
        { '--s3-endpoint': 'https://x/%zz' },
        's3-endpoint must be',
      ],
      ['a link base no URL can be', { '--s3-link-base': 'https://[' }, 's3-link-base must be'],
      ['a region no host can hold', { '--s3-region': 'a b' }, 'Invalid S3 region'],
    ])('refuses %s', async (_, flags, message) => {
      const { exitCode, stderr } = await runCli([
        'list',
        ...Object.entries({
          '--s3-bucket': 'bucket',
          '--s3-region': 'auto',
          '--s3-endpoint': 'https://store.example',
          '--s3-link-base': 'https://files.example',
          ...flags,
        }).flat(),
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(message);
    });
  });

  describe('one name in one attempt, with no lock', () => {
    const lostOnce = (matches: (url: string, method: string) => boolean) => {
      let seen = 0;
      return target.interpose(({ method, url }) => {
        if (!matches(url ?? '', method ?? '')) return undefined;
        seen += 1;
        return seen === 1 ? 'lose-answer' : undefined;
      });
    };

    it('survives losing the answer to the commit: the retry finds itself there', async () => {
      await lostOnce((url, method) => method === 'PUT' && url.includes('/runs/'));
      const { exitCode, stderr, outputs } = await uploadText('the build');
      expect(stderr).toContain('Attempt 1 failed');
      expect(exitCode).toBe(0);
      expect(await target.raw.keys('artifacts/')).toEqual([
        `artifacts/${outputs['artifact-id']}/app.bin`,
      ]);
      expect((await readJson(nameKeyOf('app.bin'))).id).toBe(outputs['artifact-id']);
      expect(await statusOf(outputs['artifact-url'])).toBe(200);
    });

    it('survives losing the answer to the commit of an overwrite, and still drops the old', async () => {
      const first = await uploadText('first');
      await lostOnce((url, method) => method === 'PUT' && url.includes('/runs/'));
      const second = await uploadText('second', { INPUT_OVERWRITE: 'true' });
      expect(second.exitCode).toBe(0);
      expect(await target.raw.keys('artifacts/')).toEqual([
        `artifacts/${second.outputs['artifact-id']}/app.bin`,
      ]);
      expect(target.goneLinkStatuses).toContain(await statusOf(first.outputs['artifact-url']));
    });

    /** Loses the answer to this job's commit, then does what another job would, before its retry. */
    const uploadLosingTheAnswerThen = async (
      meanwhile: (mine: Record<string, unknown>) => Promise<void>,
      inputs: Record<string, string> = {},
    ) => {
      await lostOnce((url, method) => method === 'PUT' && url.includes('/runs/'));
      const uploading = uploadText('mine', inputs);
      const mine = await vi.waitFor(
        async () => {
          const response = await target.raw.send('GET', nameKeyOf('app.bin'));
          expect(response.status).toBe(200);
          return (await response.json()) as Record<string, unknown>;
        },
        { interval: 10, timeout: 900 },
      );
      await meanwhile(mine);
      return { mine, result: await uploading };
    };

    it("doesn't point a name at data another job deleted by replacing it", async () => {
      const theirs = { id: 'b'.repeat(43), digest: sha256('theirs') };
      const theirData = `artifacts/${theirs.id}/app.bin`;
      const { mine, result } = await uploadLosingTheAnswerThen(
        async current => {
          await target.raw.send('PUT', theirData, { body: 'theirs' });
          await target.raw.send('PUT', nameKeyOf('app.bin'), {
            body: JSON.stringify({ ...current, ...theirs }),
          });
          await target.raw.send('DELETE', `artifacts/${String(current.id)}/app.bin`);
        },
        { INPUT_OVERWRITE: 'true' },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('was replaced or deleted while it was being stored');
      expect((await readJson(nameKeyOf('app.bin'))).id).toBe(theirs.id);
      expect(await target.raw.keys('artifacts/')).toEqual([theirData]);
      expect(mine.id).not.toBe(theirs.id);
    });

    it("doesn't bring back a name another job deleted, with its data gone", async () => {
      const { result } = await uploadLosingTheAnswerThen(async current => {
        await target.raw.send('DELETE', nameKeyOf('app.bin'));
        await target.raw.send('DELETE', `artifacts/${String(current.id)}/app.bin`);
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('was replaced or deleted while it was being stored');
      expect(await target.raw.keys('runs/7/100/1/')).toEqual([]);
    });

    it('retries a commit S3 says conflicted, and a 5xx', async () => {
      let commits = 0;
      await target.interpose(({ method, url }) => {
        if (method !== 'PUT' || url?.includes('/runs/') !== true) return undefined;
        commits += 1;
        if (commits === 1) return { status: 409, message: 'try again' };
        if (commits === 2) return { status: 503, message: 'slow down' };
        return undefined;
      });
      const { exitCode } = await uploadText('the build');
      expect(exitCode).toBe(0);
      expect(commits).toBe(3);
    });

    const racing = async ({
      first,
      second,
      inputs,
    }: {
      first: string;
      second: string;
      inputs: Record<string, string>;
    }) => {
      const write = async (job: string, content: string) => {
        await mkdir(join(runner.workDir, job));
        await writeFile(join(runner.workDir, job, 'shared.bin'), content);
      };
      await Promise.all([write('a', first), write('b', second)]);
      const run = (job: string) =>
        runUpload(
          { INPUT_PATH: `${job}/shared.bin`, INPUT_ARCHIVE: 'false', ...inputs },
          { GITHUB_OUTPUT: join(runner.rootDir, `${job}.output`) },
        );
      return Promise.all([run('a'), run('b')]);
    };

    const sendFrom = (content: string, overwrite: boolean) =>
      target.asJob(
        job =>
          job.send({
            file: new Blob([content]),
            name: 'crowded.bin',
            digest: sha256(content),
            overwrite,
            retentionDays: 0,
          }),
        {},
      );

    it('lets exactly one of a crowd win, and the rest leave nothing behind', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, job) => sendFrom(`job ${job}`, false)),
      );
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(String(result.reason)).toContain('already exists on the workflow run');
        }
      }
      expect(await target.raw.keys('artifacts/')).toHaveLength(1);
    });

    it('with overwrite, lets a crowd all succeed, with one artifact left', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, job) => sendFrom(`job ${job}`, true)),
      );
      expect(results).toHaveLength(8);
      const { id } = await readJson(nameKeyOf('crowded.bin'));
      expect(await target.raw.keys('artifacts/')).toEqual([`artifacts/${id}/crowded.bin`]);
    });

    it('lets two jobs with the same content both succeed, keeping one', async () => {
      const results = await racing({ first: 'same', second: 'same', inputs: {} });
      expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
      expect(await target.raw.keys('artifacts/')).toHaveLength(1);
      expect(await target.raw.keys('runs/')).toHaveLength(1);
    });

    it('with overwrite, lets both succeed, and the last to finish is what is left', async () => {
      const results = await racing({
        first: 'one',
        second: 'two',
        inputs: { INPUT_OVERWRITE: 'true' },
      });
      expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
      const { id } = await readJson(nameKeyOf('shared.bin'));
      expect(await target.raw.keys('artifacts/')).toEqual([`artifacts/${id}/shared.bin`]);
    });
  });

  describe('expiry, with no sweeper', () => {
    it('hides what has expired from every read, though its link still works', async () => {
      const { outputs } = await uploadText('old');
      await expire(nameKeyOf('app.bin'));

      const listed = await runCli(['list', ...target.flags()]);
      expect(JSON.parse(listed.stdout).artifacts).toEqual([]);
      const byName = await runDownload({ INPUT_NAME: 'app.bin' });
      expect(byName.exitCode).toBe(1);
      expect(byName.stdout).toContain("Artifact 'app.bin' not found");
      const deleted = await runCli([
        'delete',
        ...target.flags(),
        '--artifact-id',
        outputs['artifact-id'] ?? '',
      ]);
      expect(deleted.exitCode).toBe(1);
      expect(deleted.stderr).toContain('Not found');
      // As the README says: until an upload or the lifecycle rule removes it.
      expect(await statusOf(outputs['artifact-url'])).toBe(200);
    });

    it('lets an upload take an expired name, whatever overwrite says, dropping the old', async () => {
      const first = await uploadText('old');
      await expire(nameKeyOf('app.bin'));
      const second = await uploadText('new');
      expect(second.exitCode).toBe(0);
      expect(second.outputs['artifact-id']).not.toBe(first.outputs['artifact-id']);
      expect(target.goneLinkStatuses).toContain(await statusOf(first.outputs['artifact-url']));
    });

    it("removes what has expired for its own repository at each upload, and no one else's", async () => {
      const expired = await uploadText('old', { INPUT_ARCHIVE: 'false' }, { GITHUB_RUN_ID: '50' });
      const key = `runs/7/50/1/${sha256('app.bin')}.json`;
      await expire(key);
      const live = await uploadText('live', {}, { GITHUB_RUN_ID: '60' });
      const otherRepository = { GITHUB_REPOSITORY_ID: '8', GITHUB_REPOSITORY: 'fishballapp/other' };
      const theirs = await uploadText('theirs', {}, otherRepository);
      const theirKey = `runs/8/100/1/${sha256('app.bin')}.json`;
      await expire(theirKey);

      const { exitCode } = await uploadText('now', { INPUT_NAME: 'other', INPUT_ARCHIVE: 'true' });
      expect(exitCode).toBe(0);

      expect(target.goneLinkStatuses).toContain(await statusOf(expired.outputs['artifact-url']));
      expect(await target.raw.keys('runs/7/50/')).toEqual([]);
      expect(await statusOf(live.outputs['artifact-url'])).toBe(200);
      expect(await statusOf(theirs.outputs['artifact-url'])).toBe(200);
      expect(await target.raw.keys(theirKey)).toEqual([theirKey]);
    });

    it('never fails an upload for it, and finishes it on a later one', async () => {
      const expired = await uploadText('old', {}, { GITHUB_RUN_ID: '50' });
      const key = `runs/7/50/1/${sha256('app.bin')}.json`;
      await expire(key);
      await target.interpose(({ method, url }) =>
        method === 'DELETE' && url?.includes('/artifacts/')
          ? { status: 500, message: 'no' }
          : undefined,
      );
      const { exitCode } = await uploadText('now', { INPUT_NAME: 'one', INPUT_ARCHIVE: 'true' });
      expect(exitCode).toBe(0);
      expect(await target.raw.keys(key)).toEqual([key]);

      target.removeProxy();
      expect((await uploadText('now', { INPUT_NAME: 'two', INPUT_ARCHIVE: 'true' })).exitCode).toBe(
        0,
      );
      expect(await target.raw.keys(key)).toEqual([]);
      expect(target.goneLinkStatuses).toContain(await statusOf(expired.outputs['artifact-url']));
    });
  });

  describe('a repository by its name', () => {
    it('rewrites the record at each upload, as a lifecycle rule ages it', async () => {
      await uploadText('x');
      const key = `repositories/${sha256('fishballapp/private-thing')}.json`;
      expect((await target.raw.send('DELETE', key)).ok).toBe(true);
      await uploadText('y', { INPUT_NAME: 'other', INPUT_ARCHIVE: 'true' });
      expect(await target.raw.keys(key)).toEqual([key]);
    });

    it('follows a rename, as the new name records itself', async () => {
      await uploadText('x', {}, { GITHUB_REPOSITORY: 'fishballapp/renamed' });
      const found = await runDownload(
        {
          INPUT_REPOSITORY: 'FishballApp/Renamed',
          INPUT_NAME: 'app.bin',
          'INPUT_RUN-ID': '100',
          INPUT_PATH: 'out',
        },
        { GITHUB_REPOSITORY_ID: '999', GITHUB_REPOSITORY: 'fishballapp/somewhere-else' },
      );
      expect(found.exitCode).toBe(0);
    });
  });

  describe('outside Actions, with --scope', () => {
    const SCOPE = ['--scope', '7/100/1'];

    it('uploads, lists, downloads and deletes, as a job of that run would', async () => {
      await writeFile(join(runner.workDir, 'a.txt'), 'a');
      const uploaded = await runCli(
        ['upload', ...target.flags(), ...SCOPE, '--path', 'a.txt', '--archive', 'false'],
        OUTSIDE_ACTIONS,
      );
      expect(uploaded.exitCode).toBe(0);
      const { id } = JSON.parse(uploaded.stdout);
      expect(await target.raw.keys('runs/')).toEqual([nameKeyOf('a.txt')]);
      // With no repository's name to go on, it records none.
      expect(await target.raw.keys('repositories/')).toEqual([]);

      const listed = await runCli(['list', ...target.flags(), ...SCOPE], OUTSIDE_ACTIONS);
      expect(JSON.parse(listed.stdout).artifacts).toMatchObject([{ id, name: 'a.txt' }]);

      const downloaded = await runCli(
        ['download', ...target.flags(), ...SCOPE, '--name', 'a.txt', '--path', 'out'],
        OUTSIDE_ACTIONS,
      );
      expect(downloaded.exitCode).toBe(0);

      const deleted = await runCli(
        ['delete', ...target.flags(), ...SCOPE, '--name', 'a.txt'],
        OUTSIDE_ACTIONS,
      );
      expect(JSON.parse(deleted.stdout)).toEqual({ id, name: 'a.txt' });
      expect(await target.raw.keys()).toEqual([]);
    });

    it('wins over the job the variables say this is', async () => {
      await writeFile(join(runner.workDir, 'a.txt'), 'a');
      const { exitCode } = await runCli([
        'upload',
        ...target.flags(),
        '--scope',
        '9/900/3',
        '--path',
        'a.txt',
        '--archive',
        'false',
      ]);
      expect(exitCode).toBe(0);
      expect(await target.raw.keys('runs/')).toEqual([`runs/9/900/3/${sha256('a.txt')}.json`]);
      expect(await target.raw.keys('repositories/')).toEqual([]);
    });

    it.each([
      ['with a name', 'owner/name/100/1'],
      ['too short', '7/100'],
      ['with a letter', '7/1a/1'],
    ])('refuses one %s', async (_, scope) => {
      const { exitCode, stderr } = await runCli(['list', ...target.flags(), '--scope', scope]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`Invalid scope: '${scope}'`);
    });

    it('fails with neither, saying what to give', async () => {
      const { exitCode, stderr } = await runCli(['list', ...target.flags()], OUTSIDE_ACTIONS);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--scope <repository ID>/<run ID>/<run attempt>');
    });

    it('goes only with a bucket', async () => {
      const { exitCode, stderr } = await runCli([
        'list',
        '--server-url',
        'http://127.0.0.1:1',
        '--scope',
        '7/100/1',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('scope only go with s3-bucket');
    });
  });

  describe('deleting by ID', () => {
    it('removes the name, then the data, from another run of the repository', async () => {
      const { outputs } = await uploadText('x', {}, { GITHUB_RUN_ID: '50' });
      const deleted = await runCli([
        'delete',
        ...target.flags(),
        '--artifact-id',
        outputs['artifact-id'] ?? '',
      ]);
      expect(deleted.exitCode).toBe(0);
      expect(await target.raw.keys('runs/')).toEqual([]);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
      expect(target.goneLinkStatuses).toContain(await statusOf(outputs['artifact-url']));
    });

    it('answers that an ID a later overwrite replaced is not found', async () => {
      const first = await uploadText('first');
      const second = await uploadText('second', { INPUT_OVERWRITE: 'true' });
      const deleted = await runCli([
        'delete',
        ...target.flags(),
        '--artifact-id',
        first.outputs['artifact-id'] ?? '',
      ]);
      expect(deleted.exitCode).toBe(1);
      expect(deleted.stderr).toContain('Not found');
      expect(await statusOf(second.outputs['artifact-url'])).toBe(200);
    });

    it('says the link still works if its data could not go', async () => {
      const { outputs } = await uploadText('x');
      await target.interpose(({ method, url }) =>
        method === 'DELETE' && url?.includes('/artifacts/')
          ? { status: 403, message: 'no' }
          : undefined,
      );
      const { exitCode, stderr } = await runCli([
        'delete',
        ...target.flags(),
        '--artifact-id',
        outputs['artifact-id'] ?? '',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('its link still works');
    });
  });

  describe('holding what a bucket answers to the rules', () => {
    const storeMeta = async (name: string, override: Record<string, unknown>) => {
      const key = nameKeyOf(name);
      const response = await target.raw.send('PUT', key, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'a'.repeat(43),
          name,
          size: 1,
          digest: sha256('x'),
          expiresAt: '2100-01-01T00:00:00.000Z',
          repositoryId: '7',
          runId: '100',
          runAttempt: '1',
          ...override,
        }),
      });
      expect(response.ok).toBe(true);
    };

    it.each([
      ['a name leading out', { name: '../../evil.zip' }],
      ['an ID with a path', { id: '../'.repeat(14).padEnd(43, 'a') }],
      ['a digest of the wrong shape', { digest: 'abc' }],
      ['a negative size', { size: -1 }],
      ['an expiry that is no instant', { expiresAt: 'soon\nowned=1' }],
    ])('refuses %s, writing nothing', async (_, override) => {
      await storeMeta('a.zip', override);
      const destination = join(runner.rootDir, 'destination');
      const { exitCode, stdout } = await runDownload({ INPUT_PATH: destination });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('holds something unusable');
    });

    it('stops at the size a file was listed at, and does not retry', async () => {
      const { outputs } = await uploadText('short');
      const { 'artifact-id': id = '' } = outputs;
      await target.raw.send('PUT', `artifacts/${id}/app.bin`, {
        body: 'longer than it said it was',
      });
      const { exitCode, stdout, stderr } = await runDownload({
        INPUT_NAME: 'app.bin',
        INPUT_PATH: 'out',
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('longer than the 5 bytes it was listed at');
      expect(stderr).not.toContain('Attempt 1 failed');
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });

    it('retries a body cut short, and says so if it stays that way', {
      timeout: 20_000,
    }, async () => {
      const { outputs } = await uploadText('the whole of the file');
      await target.raw.send('PUT', `artifacts/${outputs['artifact-id']}/app.bin`, { body: 'the' });
      const { exitCode, stdout, stderr } = await runDownload({
        INPUT_NAME: 'app.bin',
        INPUT_PATH: 'out',
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Attempt 1 failed');
      expect(stdout).toContain('ended after 3 of its 21 bytes');
    });
  });

  describe('when things fail', () => {
    it('retries a 5xx, and gives up saying why', { timeout: 20_000 }, async () => {
      await target.interpose(() => ({ status: 500, message: 'boom\n::warning::injected' }));
      const { exitCode, stdout, stderr } = await uploadText('x');
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Attempt 3 failed');
      expect(stdout).toContain('boom');
      expect(stdout).not.toMatch(/^::warning::/m);
      expect(stderr).not.toMatch(/^::warning::/m);
    });

    it('does not follow a redirect', { timeout: 20_000 }, async () => {
      await target.interpose(() => ({ status: 301, message: 'moved' }));
      const { exitCode } = await uploadText('x');
      expect(exitCode).toBe(1);
    });

    it('removes the zip when the runner stops the step', async () => {
      const { promise: requested, resolve: onRequest } = Promise.withResolvers<void>();
      await target.interpose(({ method }) => {
        if (method !== 'PUT') return undefined;
        onRequest();
        return 'hang';
      });
      await writeFile(join(runner.workDir, 'a.txt'), 'a');
      const child = spawn(ACTION_NODE, [UPLOAD], {
        cwd: runner.workDir,
        stdio: 'ignore',
        env: {
          ...runner.runnerEnv,
          ...target.inputs(),
          ...target.env(),
          GITHUB_REPOSITORY_ID: '7',
          GITHUB_RUN_ID: '100',
          GITHUB_RUN_ATTEMPT: '1',
          INPUT_PATH: 'a.txt',
        },
      });
      await requested;
      expect(await readdir(runner.runnerTemp)).toHaveLength(1);

      child.kill('SIGTERM');
      await once(child, 'exit');
      expect(await readdir(runner.runnerTemp)).toEqual([]);
    });
  });

  it.runIf(process.env.S3_TEST_ENDPOINT === undefined)(
    'follows the pages of a long listing',
    async () => {
      target.fake?.limitPagesTo(2);
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        await target.store(`${name}.zip`, zipSync({ 'a.txt': strToU8(name) }));
      }
      const { stdout } = await runCli(['list', ...target.flags()]);
      expect(JSON.parse(stdout).artifacts.map(({ name }: { name: string }) => name)).toEqual([
        'a.zip',
        'b.zip',
        'c.zip',
        'd.zip',
        'e.zip',
      ]);
    },
  );

  it('holds a large file out of memory, through the signed requests', {
    timeout: 120_000,
  }, async () => {
    const fileBytes = 512 * 1024 ** 2;
    const path = join(runner.rootDir, 'big.bin');
    await writeFile(path, '');
    await truncate(path, fileBytes);
    const reporter = join(runner.rootDir, 'report-peak-memory.mjs');
    await writeFile(reporter, PEAK_REPORTER);
    const options = { NODE_OPTIONS: `--import=${reporter}` };

    const uploaded = await runUpload({ INPUT_PATH: path, INPUT_ARCHIVE: 'false' }, options);
    expect(uploaded.exitCode).toBe(0);
    expect(Number(/peak-kib=(\d+)/.exec(uploaded.stderr)?.[1]) * 1024).toBeLessThan(fileBytes / 2);

    const downloaded = await runDownload({ INPUT_NAME: 'big.bin', INPUT_PATH: 'out' }, options);
    expect(downloaded.exitCode).toBe(0);
    expect(Number(/peak-kib=(\d+)/.exec(downloaded.stderr)?.[1]) * 1024).toBeLessThan(
      fileBytes / 2,
    );
  });
});
