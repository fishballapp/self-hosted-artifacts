import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_ACTION, UPLOAD_ACTION } from '../tsdown.config.ts';
import {
  buildBundle,
  CURRENT_RUN,
  generateRunnerKeys,
  type RunClaims,
  removeBundle,
  startRunner,
  TEST_MULTIPART_FROM_BYTES,
  UNUSUAL_NAME,
  withSmallMultipart,
} from './action-harness.ts';
import { attachmentOf, PARTS_PER_SIGNING, partSizeOf, uriEncode } from './protocol.ts';
import { encodeS3Path, presignS3Request } from './s3-sigv4.ts';

vi.mock('./protocol.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./protocol.ts')>()),
  // TEST_MULTIPART_FROM_BYTES, which a hoisted mock can't import.
  MULTIPART_FROM_BYTES: 32 * 1024 ** 2,
}));

// What only a server in front of a bucket does. What it shares with the other ways to store is in the
// suites that run against all three.

const SCOPE_HEADER = 'x-amz-meta-run-scope';
const USES_THE_FAKE = process.env.S3_TEST_ENDPOINT === undefined;
const SIGNED = /X-Amz-(?:Signature|Credential)/u;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Upload = { id: string; url: string; headers: Record<string, string> };
type MultipartUpload = { kind: string; id: string; uploadId: string; partSize: number };
type SignedPart = { partNumber: number; url: string; headers: Record<string, string> };

let UPLOAD: string;
let DOWNLOAD: string;
const ACTION_NODE = process.env.ACTION_NODE ?? process.execPath;

describe('a server in front of a bucket', () => {
  let keys: CryptoKeyPair;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  let target: Awaited<ReturnType<typeof runner.startServerS3Target>>;

  beforeAll(async () => {
    [UPLOAD, DOWNLOAD] = await Promise.all([
      buildBundle(withSmallMultipart(UPLOAD_ACTION)),
      buildBundle(DOWNLOAD_ACTION),
    ]);
    keys = await generateRunnerKeys();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([UPLOAD, DOWNLOAD].map(removeBundle));
  });

  beforeEach(async () => {
    runner = await startRunner({ keys });
    target = await runner.startServerS3Target();
  });

  afterEach(async () => {
    await runner.stop();
  });

  const authorized = async () => ({ Authorization: `Bearer ${await runner.signToken()}` });

  const declarationOf = (content: string, name: string, more = '') =>
    `name=${encodeURIComponent(name)}&digest=${sha256(content)}&size=${Buffer.byteLength(content)}${more}`;

  const create = async (content: string, { name = 'a.bin', more = '' } = {}) => {
    const response = await fetch(
      `${target.serverUrl}/uploads?${declarationOf(content, name, more)}`,
      { method: 'POST', headers: await authorized() },
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { upload: Upload }).upload;
  };

  const send = (upload: Upload, body: string) =>
    fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Blob([body]) });

  const commit = async (id: string, content: string, { name = 'a.bin', more = '' } = {}) =>
    fetch(`${target.serverUrl}/uploads/${id}/commit?${declarationOf(content, name, more)}`, {
      method: 'POST',
      headers: await authorized(),
    });

  /** All three steps, as a job takes them. */
  const stored = async (content: string, options: { name?: string; more?: string } = {}) => {
    const upload = await create(content, options);
    expect((await send(upload, content)).ok).toBe(true);
    const committed = await commit(upload.id, content, options);
    expect(committed.status).toBe(201);
    return (await committed.json()) as { id: string; name: string; expiresAt: string };
  };

  const linkOf = ({ id, name = 'a.bin' }: { id: string; name?: string }) =>
    `${target.serverUrl}/${id}/${uriEncode(name)}`;

  const dataKeyOf = ({ id, name = 'a.bin' }: { id: string; name?: string }) =>
    `artifacts/${id}/${name}`;

  const nameKeyOf = (name = 'a.bin', { runAttempt = '1' } = {}) =>
    `runs/7/100/${runAttempt}/${sha256(name)}.json`;

  const statusOfLink = async (artifact: { id: string; name?: string }) =>
    (await fetch(linkOf(artifact), { redirect: 'manual' })).status;

  describe('an upload', () => {
    it('is given a URL on the bucket, and only the headers fetch would not set', async () => {
      const upload = await create('the build');
      expect(new URL(upload.url).pathname).toContain(`/${dataKeyOf(upload)}`);
      expect(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        `content-disposition;content-length;content-type;host;x-amz-checksum-sha256;${SCOPE_HEADER}`,
      );
      expect(new URL(upload.url).searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(upload.headers).toEqual({
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-amz-checksum-sha256': createHash('sha256').update('the build').digest('base64'),
        [SCOPE_HEADER]: '7/100/1',
      });
    });

    it('lands as a direct upload would, with what a link needs', async () => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);
      const head = await target.raw.send('HEAD', dataKeyOf(upload));
      expect(head.headers.get('content-disposition')).toBe('attachment');
      expect(head.headers.get('content-type')).toBe('application/octet-stream');
      expect(head.headers.get(SCOPE_HEADER)).toBe('7/100/1');
    });

    it.each([
      ['longer', 'the build, and more'],
      ['shorter', 'the'],
    ])('is refused at the PUT with a body %s than it declared', async (_, body) => {
      const upload = await create('the build');
      const response = await send(upload, body);
      expect(response.status).toBe(403);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it('is refused at the PUT with the right size and the wrong checksum', async () => {
      const upload = await create('the build');
      const response = await send(upload, 'the bilge');
      expect(response.status).toBe(400);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it.each([
      ['a changed type', { 'content-type': 'text/html' }],
      ['a changed disposition', { 'content-disposition': 'inline' }],
      ['another scope', { [SCOPE_HEADER]: '7/100/2' }],
    ])('is refused at the PUT with %s', async (_, changed) => {
      const upload = await create('the build');
      const response = await fetch(upload.url, {
        method: 'PUT',
        headers: { ...upload.headers, ...changed },
        body: new Blob(['the build']),
      });
      expect(response.status).toBe(403);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it('is refused at the PUT with a signed header missing', async () => {
      const upload = await create('the build');
      const { [SCOPE_HEADER]: _scope, ...headers } = upload.headers;
      const response = await fetch(upload.url, {
        method: 'PUT',
        headers,
        body: new Blob(['the build']),
      });
      // R2 and the fake say 403, and MinIO 400.
      expect([400, 403]).toContain(response.status);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it('can write nowhere else with that signature', async () => {
      const upload = await create('the build');
      const moved = upload.url.replace(upload.id, 'b'.repeat(43));
      const response = await fetch(moved, {
        method: 'PUT',
        headers: upload.headers,
        body: new Blob(['the build']),
      });
      expect(response.status).toBe(403);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it('is refused at the PUT once its URL has expired', async () => {
      const { host, region, credentials } = target.signing;
      const path = `/${target.bucket}/${dataKeyOf({ id: 'c'.repeat(43) })}`;
      const search = presignS3Request({
        method: 'PUT',
        host,
        path,
        credentials,
        region,
        nowMs: Date.now() - 120_000,
        expiresInSeconds: 60,
      });
      const response = await fetch(`http://${host}${encodeS3Path(path)}?${search}`, {
        method: 'PUT',
        body: new Blob(['late']),
      });
      expect(response.status).toBe(403);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
    });

    it('with a session token, carries it in the URL', { skip: !USES_THE_FAKE }, async () => {
      target = await runner.startServerS3Target({ sessionToken: 'the-session' });
      const upload = await create('the build');
      expect(new URL(upload.url).searchParams.get('X-Amz-Security-Token')).toBe('the-session');
      expect((await send(upload, 'the build')).ok).toBe(true);
      expect((await commit(upload.id, 'the build')).status).toBe(201);
    });
  });

  describe('a commit', () => {
    it('answers 404 before the PUT', async () => {
      const upload = await create('the build');
      expect((await commit(upload.id, 'the build')).status).toBe(404);
      expect(await target.raw.keys('runs/')).toEqual([]);
    });

    it('answers 404 for an ID nothing was uploaded to', async () => {
      expect((await commit('d'.repeat(43), 'the build')).status).toBe(404);
    });

    it.each<[string, Partial<RunClaims>]>([
      ['repository', { repository: 'fishballapp/other', repository_id: '8' }],
      ['run', { run_id: '101' }],
      ['attempt', { run_attempt: '2' }],
    ])("answers 404 for another %s's upload, which stays its own", async (_, claims) => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);

      runner.actAs(claims);
      expect((await commit(upload.id, 'the build')).status).toBe(404);
      expect(await target.raw.keys('runs/')).toEqual([]);

      runner.actAs(CURRENT_RUN);
      expect((await commit(upload.id, 'the build')).status).toBe(201);
    });

    it('answers 404 for another size than the body has', async () => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);
      expect((await commit(upload.id, 'the build, and more')).status).toBe(404);
    });

    it('answers 404 under another name than the body has', async () => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);
      expect((await commit(upload.id, 'the build', { name: 'b.bin' })).status).toBe(404);
    });

    it('records the repository, as a read across repositories needs', async () => {
      await stored('the build');
      const key = `repositories/${sha256(CURRENT_RUN.repository)}.json`;
      expect(await (await target.raw.send('GET', key)).json()).toEqual({
        name: CURRENT_RUN.repository,
        repositoryId: CURRENT_RUN.repository_id,
      });
    });

    it('committed again, answers 200 with the artifact as it is', async () => {
      const first = await stored('the build');
      const again = await commit(first.id, 'the build', { more: '&retention-days=1' });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ id: first.id, expiresAt: first.expiresAt });
    });

    it('survives losing the answer to its own write', async () => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);
      let writes = 0;
      await target.interpose(({ method, url }) => {
        if (method !== 'PUT' || url?.includes('/runs/') !== true) return undefined;
        writes += 1;
        return writes === 1 ? 'lose-answer' : undefined;
      });

      const answer = await commit(upload.id, 'the build');

      expect(answer.status).toBe(201);
      expect(writes).toBe(1);
      expect(await (await target.raw.send('GET', nameKeyOf())).json()).toMatchObject({
        id: upload.id,
      });
    });

    it("doesn't bring back a name deleted, with its data, after losing that answer", async () => {
      const upload = await create('the build');
      expect((await send(upload, 'the build')).ok).toBe(true);
      await target.interpose(({ method, url }) =>
        method === 'PUT' && url?.includes('/runs/') === true ? 'lose-answer' : undefined,
      );

      const committing = commit(upload.id, 'the build');
      await vi.waitFor(
        async () => expect((await target.raw.send('HEAD', nameKeyOf())).status).toBe(200),
        { interval: 10, timeout: 900 },
      );
      await target.raw.send('DELETE', nameKeyOf());
      await target.raw.send('DELETE', dataKeyOf(upload));

      expect((await committing).status).toBe(404);
      expect(await target.raw.keys('runs/')).toEqual([]);
    });

    it('with other content under the name, answers 409 and deletes its own data', async () => {
      // Started while the name was free, so only its commit can find it taken.
      const late = await create('late');
      expect((await send(late, 'late')).ok).toBe(true);
      const first = await stored('first');

      expect((await commit(late.id, 'late')).status).toBe(409);

      expect(await target.raw.keys('artifacts/')).toEqual([dataKeyOf(first)]);
      expect(await statusOfLink(first)).toBe(302);
    });

    it('with the same content under another ID, answers with theirs and deletes its own', async () => {
      const one = await create('same');
      const two = await create('same');
      expect((await send(one, 'same')).ok).toBe(true);
      expect((await send(two, 'same')).ok).toBe(true);
      expect((await commit(one.id, 'same')).status).toBe(201);

      const answer = await commit(two.id, 'same');

      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ id: one.id });
      expect(await target.raw.keys('artifacts/')).toEqual([dataKeyOf(one)]);
    });

    it('with overwrite, drops the old data and the old link', async () => {
      const first = await stored('first');
      const second = await stored('second', { more: '&overwrite=true' });
      expect(second.id).not.toBe(first.id);
      expect(await target.raw.keys('artifacts/')).toEqual([dataKeyOf(second)]);
      expect(await statusOfLink(first)).toBe(404);
      expect(await statusOfLink(second)).toBe(302);
    });

    it("expires when the retention says, by the server's cap", async () => {
      const artifact = await stored('the build', { more: '&retention-days=1000' });
      const days = (Date.parse(artifact.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(Math.ceil(days)).toBe(30);
    });
  });

  describe('a link', () => {
    it('redirects, to something anyone can read for a few minutes', async () => {
      const artifact = await stored('the build');
      const answer = await fetch(linkOf(artifact), { redirect: 'manual' });
      expect(answer.status).toBe(302);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      const location = new URL(answer.headers.get('location') ?? '');
      expect(location.pathname).toContain(`/${dataKeyOf(artifact)}`);
      expect(location.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(location.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="a.bin"',
      );

      const read = await fetch(location, { headers: { 'accept-encoding': 'identity' } });
      expect(read.status).toBe(200);
      expect(await read.text()).toBe('the build');
      expect(read.headers.get('content-disposition')).toBe('attachment; filename="a.bin"');
    });

    it('reaches the bucket for any name upstream takes', async () => {
      const name = `${UNUSUAL_NAME}.bin`;
      const artifact = await stored('the build', { name });
      const answer = await fetch(linkOf(artifact), { redirect: 'manual' });
      expect(answer.status).toBe(302);
      const read = await fetch(answer.headers.get('location') ?? '', {
        headers: { 'accept-encoding': 'identity' },
      });
      expect(read.status).toBe(200);
      expect(await read.text()).toBe('the build');
      expect(read.headers.get('content-disposition')).toBe(attachmentOf(name));
    });

    it('needs that URL: the bucket itself stays private', async () => {
      const artifact = await stored('the build');
      const { origin } = new URL(
        (await fetch(linkOf(artifact), { redirect: 'manual' })).headers.get('location') ?? '',
      );
      const key = `${origin}/${target.bucket}/${dataKeyOf(artifact)}`;
      expect((await fetch(key)).status).toBe(403);
      expect((await fetch(`${origin}/${target.bucket}/${nameKeyOf()}`)).status).toBe(403);
      expect((await fetch(`${origin}/${target.bucket}?list-type=2`)).status).toBe(403);
    });

    it('answers a HEAD itself, with no redirect', async () => {
      const artifact = await stored('the build');
      const answer = await fetch(linkOf(artifact), { method: 'HEAD', redirect: 'manual' });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('location')).toBeNull();
      expect(answer.headers.get('content-length')).toBe('9');
      expect(answer.headers.get('content-type')).toBe('application/octet-stream');
      expect(answer.headers.get('content-disposition')).toBe('attachment; filename="a.bin"');
    });

    it('costs two requests of the bucket, of the kinds the README says', async () => {
      const artifact = await stored('the build');
      const seen: string[] = [];
      await target.interpose(({ method, url = '' }) => {
        seen.push(`${method} ${url.includes('/runs/') ? 'name' : 'data'}`);
        return undefined;
      });
      expect(await statusOfLink(artifact)).toBe(302);
      expect(seen.toSorted()).toEqual(['GET name', 'HEAD data']);
    });

    it('looks names up with one listing, however many are asked for', async () => {
      const artifact = await stored('the build');
      const listings: string[] = [];
      await target.interpose(({ url = '' }) => {
        if (url.includes('list-type=2')) listings.push(url);
        return undefined;
      });
      const listed = await fetch(
        `${target.serverUrl}/artifacts?name=${artifact.name}&name=${artifact.name}.zip&name=other`,
        { headers: await authorized() },
      );
      expect(((await listed.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(1);
      expect(listings).toHaveLength(1);
    });

    it('stops with its delete', async () => {
      const artifact = await stored('the build');
      const removed = await fetch(`${target.serverUrl}/artifacts/${artifact.id}`, {
        method: 'DELETE',
        headers: await authorized(),
      });
      expect(removed.status).toBe(200);
      expect(await statusOfLink(artifact)).toBe(404);
      expect(await target.raw.keys('artifacts/')).toEqual([]);
      expect(await target.raw.keys('runs/')).toEqual([]);
    });

    it('stops at its name, whatever data is left', async () => {
      const artifact = await stored('the build');
      await target.raw.send('DELETE', nameKeyOf());
      expect(await statusOfLink(artifact)).toBe(404);
    });

    it('stops at its expiry, though the data is still there', async () => {
      const artifact = await stored('the build');
      const file = await (await target.raw.send('GET', nameKeyOf())).json();
      await target.raw.send('PUT', nameKeyOf(), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...file, expiresAt: '2020-01-01T00:00:00.000Z' }),
      });
      expect(await statusOfLink(artifact)).toBe(404);
      expect(await target.raw.keys('artifacts/')).toEqual([dataKeyOf(artifact)]);
    });

    it.each([
      ['another name', 'b.bin'],
      ['a name with an escape', 'a.bin%2f..%2f..%2frepositories'],
      ['a name that climbs', '..%2fa.bin'],
    ])('is a 404 with %s on a real ID', async (_, name) => {
      const artifact = await stored('the build');
      expect(await statusOfLink({ id: artifact.id, name })).toBe(404);
    });

    it('is a 404 with data no name refers to, or no scope to look in', async () => {
      const artifact = await stored('the build');
      await target.raw.send('PUT', dataKeyOf({ id: 'e'.repeat(43) }), { body: 'stray' });
      expect(await statusOfLink({ id: 'e'.repeat(43) })).toBe(404);
      await target.raw.send('PUT', dataKeyOf({ id: 'f'.repeat(43) }), {
        headers: { [SCOPE_HEADER]: '7/100/1' },
        body: 'claims the name',
      });
      expect(await statusOfLink({ id: 'f'.repeat(43) })).toBe(404);
      expect(await statusOfLink(artifact)).toBe(302);
    });

    it('is a 404 with a query string, as every link is', async () => {
      const artifact = await stored('the build');
      expect((await fetch(`${linkOf(artifact)}?x=1`, { redirect: 'manual' })).status).toBe(404);
    });
  });

  describe('a delete', () => {
    it("answers 403 for another repository's, and leaves it", async () => {
      const artifact = await stored('the build');
      runner.actAs({ repository: 'fishballapp/other', repository_id: '8' });
      const answer = await fetch(`${target.serverUrl}/artifacts/${artifact.id}`, {
        method: 'DELETE',
        headers: await authorized(),
      });
      expect(answer.status).toBe(403);
      runner.actAs(CURRENT_RUN);
      expect(await statusOfLink(artifact)).toBe(302);
    });

    it('answers 404 for an ID that has been replaced', async () => {
      const first = await stored('first');
      await stored('second', { more: '&overwrite=true' });
      const answer = await fetch(`${target.serverUrl}/artifacts/${first.id}`, {
        method: 'DELETE',
        headers: await authorized(),
      });
      expect(answer.status).toBe(404);
    });
  });

  describe('an upload in parts', () => {
    const PART_BYTES = partSizeOf(TEST_MULTIPART_FROM_BYTES);
    const TOTAL_BYTES = 2 * PART_BYTES + 1024 ** 2;
    const DIGEST = 'a'.repeat(64);
    const declaration = (more = '', size = TOTAL_BYTES) =>
      `name=a.bin&digest=${DIGEST}&size=${size}${more}`;
    const md5Of = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('base64');
    const PARTS = [
      Buffer.alloc(PART_BYTES, 1),
      Buffer.alloc(PART_BYTES, 2),
      Buffer.alloc(1024 ** 2, 3),
    ] as const;
    const FIRST_MD5 = md5Of(PARTS[0]);

    const startParts = async (): Promise<MultipartUpload> => {
      const answer = await fetch(`${target.serverUrl}/uploads?${declaration()}`, {
        method: 'POST',
        headers: await authorized(),
      });
      expect(answer.status).toBe(201);
      return ((await answer.json()) as { upload: MultipartUpload }).upload;
    };

    const postRoute = async (
      { id }: { id: string },
      route: string,
      body: unknown,
      more?: string,
      size?: number,
    ) =>
      fetch(`${target.serverUrl}/uploads/${id}/${route}?${declaration(more, size)}`, {
        method: 'POST',
        headers: { ...(await authorized()), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const sign = async (
      upload: MultipartUpload,
      parts: readonly { partNumber: number; md5: string }[],
    ) => {
      const answer = await postRoute(upload, 'parts', { uploadId: upload.uploadId, parts });
      expect(answer.status).toBe(200);
      return ((await answer.json()) as { parts: SignedPart[] }).parts;
    };

    const signAll = (upload: MultipartUpload) =>
      sign(
        upload,
        PARTS.map((part, index) => ({ partNumber: index + 1, md5: md5Of(part) })),
      );

    const sendAll = async (upload: MultipartUpload) => {
      const signed = await signAll(upload);
      return Promise.all(
        signed.map(async ({ partNumber, url, headers }, index) => {
          const sent = await fetch(url, { method: 'PUT', headers, body: PARTS[index] });
          expect(sent.status).toBe(200);
          return { partNumber, etag: sent.headers.get('etag') };
        }),
      );
    };

    const commitParts = (
      upload: MultipartUpload,
      parts: readonly unknown[],
      more?: string,
      size?: number,
    ) => postRoute(upload, 'commit', { uploadId: upload.uploadId, parts }, more, size);

    it('is what the server answers from its threshold, with the part size', async () => {
      const upload = await startParts();
      expect(upload).toMatchObject({ kind: 'multipart', partSize: PART_BYTES });
      expect(upload).not.toHaveProperty('url');
      expect(await target.raw.pendingUploads()).toEqual([dataKeyOf(upload)]);
    });

    it('stays one signed `PUT` just below it', async () => {
      const answer = await fetch(
        `${target.serverUrl}/uploads?${declaration('', TEST_MULTIPART_FROM_BYTES - 1)}`,
        { method: 'POST', headers: await authorized() },
      );
      expect(answer.status).toBe(201);
      const { upload } = (await answer.json()) as { upload: Upload & { kind: string } };
      expect(upload.kind).toBe('single');
      expect(new URL(upload.url).searchParams.has('uploadId')).toBe(false);
    });

    it("is over the server's limit like anything else", async () => {
      const answer = await fetch(`${target.serverUrl}/uploads?${declaration('', 2 * 1024 ** 3)}`, {
        method: 'POST',
        headers: await authorized(),
      });
      expect(answer.status).toBe(413);
    });

    describe('signing', () => {
      it('asks nothing of the bucket, and signs what S3 holds a part to', async () => {
        const upload = await startParts();
        const seen: string[] = [];
        await target.interpose(({ method, url = '' }) => {
          if (url.includes('uploadId')) seen.push(`${method} ${url}`);
          return undefined;
        });
        const [signed] = await signAll(upload);
        expect(seen).toEqual([]);
        const url = new URL(signed?.url ?? '');
        expect(url.pathname).toContain(`/${dataKeyOf(upload)}`);
        expect(url.searchParams.get('partNumber')).toBe('1');
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-md5;host');
        expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
        expect(signed?.headers).toEqual({ 'content-md5': md5Of(PARTS[0]) });
      });

      it('takes a token, as every route does', async () => {
        const upload = await startParts();
        const answer = await fetch(
          `${target.serverUrl}/uploads/${upload.id}/parts?${declaration()}`,
          { method: 'POST', body: JSON.stringify({ uploadId: upload.uploadId, parts: [] }) },
        );
        expect(answer.status).toBe(401);
      });

      it.each<[string, (upload: MultipartUpload) => unknown]>([
        ['no upload ID', () => ({ parts: [{ partNumber: 1, md5: FIRST_MD5 }] })],
        ['no parts', ({ uploadId }) => ({ uploadId, parts: [] })],
        ['a bad MD5', ({ uploadId }) => ({ uploadId, parts: [{ partNumber: 1, md5: 'nope' }] })],
        ['part 0', ({ uploadId }) => ({ uploadId, parts: [{ partNumber: 0, md5: FIRST_MD5 }] })],
        [
          'a part past what the size needs',
          ({ uploadId }) => ({ uploadId, parts: [{ partNumber: 4, md5: FIRST_MD5 }] }),
        ],
        [
          'more than a batch',
          ({ uploadId }) => ({
            uploadId,
            parts: Array.from({ length: PARTS_PER_SIGNING + 1 }, () => ({
              partNumber: 1,
              md5: FIRST_MD5,
            })),
          }),
        ],
      ])('answers 400 for %s, saying nothing of what it was sent', async (_, bodyOf) => {
        const upload = await startParts();
        const answer = await postRoute(upload, 'parts', bodyOf(upload));
        expect(answer.status).toBe(400);
        expect(await answer.text()).not.toContain(upload.uploadId);
      });

      it('stops reading a body far longer than any batch', async () => {
        const upload = await startParts();
        const answer = await postRoute(upload, 'parts', 'x'.repeat(3 * 1024 ** 2)).catch(
          () => undefined,
        );
        // Node cuts the connection, so this may never have an answer to read.
        expect(answer?.status ?? 400).toBe(400);
        expect((await signAll(upload)).length).toBe(3);
      });

      it('signs nothing for a file too small to go in parts', async () => {
        const upload = await startParts();
        const answer = await postRoute(
          upload,
          'parts',
          { uploadId: upload.uploadId, parts: [{ partNumber: 1, md5: md5Of(PARTS[0]) }] },
          '',
          TEST_MULTIPART_FROM_BYTES - 1,
        );
        expect(answer.status).toBe(400);
      });

      it('leaves the upload ID out of every URL a server is sent', async () => {
        const urls: string[] = [];
        await target.interpose(({ url = '' }) => {
          if (url.startsWith('/uploads')) urls.push(url);
          return undefined;
        });
        const path = join(runner.rootDir, 'big.bin');
        await writeFile(path, Buffer.concat(PARTS));
        const result = await runner.runNode(ACTION_NODE, [UPLOAD], {
          ...target.inputs(),
          ...target.env(),
          INPUT_PATH: path,
          INPUT_ARCHIVE: 'false',
        });
        expect(result.exitCode).toBe(0);
        expect(urls.map(url => url.split('?')[0]?.replace(/[A-Za-z0-9_-]{43}/u, '<id>'))).toEqual([
          '/uploads',
          '/uploads/<id>/parts',
          '/uploads/<id>/commit',
        ]);
        expect(urls.filter(url => /upload-?id/iu.test(url))).toEqual([]);
      });
    });

    describe('a part', () => {
      /** A store may refuse from the headers alone, and cut off the body it's still being sent. */
      const statusOfRefused = (answer: Promise<Response>) =>
        answer.then(
          ({ status }) => status,
          () => 'cut off',
        );

      it.each([
        ['longer', Buffer.alloc(PART_BYTES + 1, 1)],
        ['shorter', Buffer.alloc(PART_BYTES - 1, 1)],
      ])('is refused at the PUT when %s than signed', async (_, body) => {
        const [signed] = await signAll(await startParts());
        const status = await statusOfRefused(
          fetch(signed?.url ?? '', { method: 'PUT', headers: signed?.headers ?? {}, body }),
        );
        expect([403, 'cut off']).toContain(status);
      });

      it('is refused at the PUT when it is not its MD5', async () => {
        const [signed] = await signAll(await startParts());
        const answer = await fetch(signed?.url ?? '', {
          method: 'PUT',
          headers: signed?.headers ?? {},
          body: PARTS[1],
        });
        expect(answer.status).toBe(400);
      });

      it('is refused at the PUT with its MD5 changed or missing', async () => {
        const [signed] = await signAll(await startParts());
        const changed = await statusOfRefused(
          fetch(signed?.url ?? '', {
            method: 'PUT',
            headers: { 'content-md5': md5Of(PARTS[1]) },
            body: PARTS[1],
          }),
        );
        expect([403, 'cut off']).toContain(changed);
        const missing = await statusOfRefused(
          fetch(signed?.url ?? '', { method: 'PUT', body: PARTS[0] }),
        );
        // R2 and the fake say 403, and MinIO 400, as of any signed header.
        expect([400, 403, 'cut off']).toContain(missing);
      });

      it('can be sent under no other number or upload with that signature', async () => {
        const upload = await startParts();
        const [signed] = await signAll(upload);
        const url = new URL(signed?.url ?? '');
        url.searchParams.set('partNumber', '2');
        const status = await statusOfRefused(
          fetch(url, { method: 'PUT', headers: signed?.headers ?? {}, body: PARTS[0] }),
        );
        expect([403, 'cut off']).toContain(status);
      });
    });

    describe('its commit', () => {
      it('makes the object, with its scope and how it is served, then names it', async () => {
        const upload = await startParts();
        const answer = await commitParts(upload, await sendAll(upload));
        expect(answer.status).toBe(201);
        expect(await answer.json()).toMatchObject({ id: upload.id, size: TOTAL_BYTES });
        const head = await target.raw.send('HEAD', dataKeyOf(upload));
        expect(head.headers.get(SCOPE_HEADER)).toBe('7/100/1');
        expect(head.headers.get('content-disposition')).toBe('attachment');
        expect(head.headers.get('content-type')).toBe('application/octet-stream');
        expect(await target.raw.pendingUploads()).toEqual([]);
        expect(await statusOfLink(upload)).toBe(302);
        const read = await fetch(linkOf(upload), { headers: { 'accept-encoding': 'identity' } });
        expect(Buffer.from(await read.arrayBuffer()).equals(Buffer.concat(PARTS))).toBe(true);
      });

      it.each<[string, (parts: { partNumber: number; etag: string | null }[]) => unknown[]]>([
        ['one missing', parts => parts.slice(0, -1)],
        ['one out of order', parts => parts.toReversed()],
        ['one too many', parts => [...parts, { partNumber: 4, etag: '"x"' }]],
      ])('answers 400 with %s, before asking the bucket', async (_, partsOf) => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        const answer = await commitParts(upload, partsOf(parts));
        expect(answer.status).toBe(400);
        expect(await target.raw.pendingUploads()).toEqual([dataKeyOf(upload)]);
      });

      it('survives losing the answer to the object being finished', async () => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        let finishes = 0;
        await target.interpose(({ method, url = '' }) => {
          if (method !== 'POST' || !url.includes('uploadId=')) return undefined;
          finishes += 1;
          return finishes === 1 ? 'lose-answer' : undefined;
        });

        const answer = await commitParts(upload, parts);

        expect(answer.status).toBe(201);
        expect(finishes).toBe(2);
        expect(await statusOfLink(upload)).toBe(302);
      });

      it('committed again after a lost answer, answers 200 with the artifact', async () => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        const first = await commitParts(upload, parts);
        expect(first.status).toBe(201);

        const again = await commitParts(upload, parts);

        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ id: upload.id });
      });

      it('answers 404 once what it would finish is gone, naming nothing', async () => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        expect((await postRoute(upload, 'abort', { uploadId: upload.uploadId })).status).toBe(200);
        expect((await commitParts(upload, parts)).status).toBe(404);
        expect(await target.raw.keys('runs/')).toEqual([]);
      });

      it('answers 404 for another size than was sent, which it can still commit', async () => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        const otherSize = TOTAL_BYTES + 1;
        expect((await commitParts(upload, parts, '', otherSize)).status).toBe(404);
        expect(await target.raw.keys('runs/')).toEqual([]);
        expect((await commitParts(upload, parts)).status).toBe(201);
      });

      it.each<[string, Partial<RunClaims>]>([
        ['repository', { repository: 'fishballapp/other', repository_id: '8' }],
        ['run', { run_id: '101' }],
        ['attempt', { run_attempt: '2' }],
      ])("answers 404 for another %s's upload, which stays its own", async (_, claims) => {
        const upload = await startParts();
        const parts = await sendAll(upload);

        runner.actAs(claims);
        expect((await commitParts(upload, parts)).status).toBe(404);
        expect(await target.raw.keys('runs/')).toEqual([]);

        runner.actAs(CURRENT_RUN);
        expect((await commitParts(upload, parts)).status).toBe(201);
      });

      it('answers 500 for a part the bucket refuses, logging no upload ID', async () => {
        const upload = await startParts();
        const parts = await sendAll(upload);
        const answer = await commitParts(
          upload,
          parts.map(part => ({ ...part, etag: '"not-it"' })),
        );
        expect(answer.status).toBe(500);
        expect(await answer.json()).toEqual({ error: 'Internal error' });
        expect(target.serverLog.join('\n')).not.toContain(upload.uploadId);
      });
    });

    describe('stopping it', () => {
      it('takes a token, and stops it', async () => {
        const upload = await startParts();
        const anonymous = await fetch(
          `${target.serverUrl}/uploads/${upload.id}/abort?${declaration()}`,
          { method: 'POST', body: JSON.stringify({ uploadId: upload.uploadId }) },
        );
        expect(anonymous.status).toBe(401);
        expect(await target.raw.pendingUploads()).toEqual([dataKeyOf(upload)]);

        const answer = await postRoute(upload, 'abort', { uploadId: upload.uploadId });
        expect(answer.status).toBe(200);
        expect(await target.raw.pendingUploads()).toEqual([]);
      });

      it('is fine with what is already stopped', async () => {
        const upload = await startParts();
        expect((await postRoute(upload, 'abort', { uploadId: upload.uploadId })).status).toBe(200);
        expect((await postRoute(upload, 'abort', { uploadId: upload.uploadId })).status).toBe(200);
      });

      it('logs that the bucket would not, and no upload ID', async () => {
        const upload = await startParts();
        await target.interpose(({ method, url = '' }) =>
          method === 'DELETE' && url.includes('uploadId=')
            ? { status: 500, message: `No such thing as ${upload.uploadId}` }
            : undefined,
        );
        const answer = await postRoute(upload, 'abort', { uploadId: upload.uploadId });
        expect(answer.status).toBe(200);
        const log = target.serverLog.join('\n');
        expect(log).toContain("which the bucket's lifecycle rule will");
        expect(log).not.toContain(upload.uploadId);
        expect(log).not.toContain(upload.id);
      });
    });
  });

  it('takes no body itself', async () => {
    const upload = await create('the build');
    const answer = await fetch(`${target.serverUrl}/uploads/${upload.id}`, {
      method: 'PUT',
      body: 'the build',
    });
    expect(answer.status).toBe(404);
    expect(await target.raw.keys('artifacts/')).toEqual([]);
  });

  it('says it is healthy without asking the bucket', async () => {
    const seen: string[] = [];
    await target.interpose(({ method }) => {
      seen.push(String(method));
      return undefined;
    });
    expect((await fetch(`${target.serverUrl}/healthz`)).status).toBe(200);
    expect(seen).toEqual([]);
  });

  describe('what it never says', () => {
    const expectQuiet = (texts: readonly string[], ids: readonly string[]) => {
      for (const text of texts) {
        expect(text).not.toMatch(SIGNED);
        expect(text).not.toContain('X-Amz-Security-Token');
      }
      const log = target.serverLog.join('\n');
      expect(log).not.toMatch(SIGNED);
      expect(log).not.toContain(target.signing.credentials.accessKeyId);
      for (const id of ids) expect(log).not.toContain(id);
    };

    it('holds a signature in no output or log, all the way through', async () => {
      const path = join(runner.rootDir, 'app.bin');
      await writeFile(path, 'the build');
      const inputs = { ...target.inputs(), ...target.env() };
      const uploaded = await runner.runNode(ACTION_NODE, [UPLOAD], {
        ...inputs,
        INPUT_PATH: path,
        INPUT_ARCHIVE: 'false',
      });
      expect(uploaded.exitCode).toBe(0);
      const outputs = await readFile(runner.outputPath, 'utf8');
      const id = (await runner.readOutputs())['artifact-id'] ?? '';

      await mkdir(join(runner.rootDir, 'out'));
      const downloaded = await runner.runNode(ACTION_NODE, [DOWNLOAD], {
        ...inputs,
        INPUT_NAME: 'app.bin',
        INPUT_PATH: join(runner.rootDir, 'out'),
      });
      expect(downloaded.exitCode).toBe(0);
      expect(await readFile(join(runner.rootDir, 'out', 'app.bin'), 'utf8')).toBe('the build');

      expect(await statusOfLink({ id, name: 'app.bin' })).toBe(302);
      expectQuiet(
        [uploaded.stdout, uploaded.stderr, downloaded.stdout, downloaded.stderr, outputs],
        [id],
      );
    });

    it('holds a signature in nothing when the upload is refused', async () => {
      await target.interpose(request =>
        target.isUpload(request) ? { status: 403, message: 'Nope' } : undefined,
      );
      await writeFile(join(runner.workDir, 'app.bin'), 'the build');
      const result = await runner.runNode(ACTION_NODE, [UPLOAD], {
        ...target.inputs(),
        ...target.env(),
        INPUT_PATH: 'app.bin',
        INPUT_ARCHIVE: 'false',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HTTP 403: Refused');
      expectQuiet([result.stdout, result.stderr], []);
    });

    it('answers a failing bucket with a 500, logging no full token', {
      timeout: 20_000,
    }, async () => {
      const artifact = await stored('the build');
      await target.interpose(() => ({ status: 503, message: 'Slow down' }));

      const answer = await fetch(linkOf(artifact), { redirect: 'manual' });

      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ error: 'Internal error' });
      const log = target.serverLog.join('\n');
      expect(log).toContain('request failed');
      expect(log).toContain(`artifacts/${artifact.id.slice(0, 8)}…`);
      expectQuiet([], [artifact.id]);
    });

    it('logs no full token when the data of what it replaced stays', async () => {
      const first = await stored('first');
      await target.interpose(({ method, url }) =>
        method === 'DELETE' && url?.includes(first.id) === true
          ? { status: 403, message: 'No' }
          : undefined,
      );
      const second = await stored('second', { more: '&overwrite=true' });
      expect(await target.raw.keys('artifacts/')).toEqual(
        [dataKeyOf(first), dataKeyOf(second)].toSorted(),
      );
      expect(target.serverLog.join('\n')).toContain("which the bucket's lifecycle rule will");
      expectQuiet([], [first.id, second.id]);
    });
  });

  it('a lost commit answer costs a client nothing', { timeout: 20_000 }, async () => {
    let commits = 0;
    await target.interpose(({ method, url = '' }) => {
      if (method !== 'POST' || !url.includes('/commit')) return undefined;
      commits += 1;
      return commits === 1 ? 'lose-answer' : undefined;
    });
    await writeFile(join(runner.workDir, 'app.bin'), 'the build');
    const result = await runner.runNode(ACTION_NODE, [UPLOAD], {
      ...target.inputs(),
      ...target.env(),
      INPUT_PATH: 'app.bin',
      INPUT_ARCHIVE: 'false',
    });
    expect(result.stderr).toContain('Attempt 1 failed (The upload failed');
    expect(result.exitCode).toBe(0);
    // The next attempt's first step finds the digest stored, and that's all it takes.
    expect(commits).toBe(1);
    expect(await target.raw.keys('artifacts/')).toEqual([
      dataKeyOf({ id: (await runner.readOutputs())['artifact-id'] ?? '', name: 'app.bin' }),
    ]);
  });
});
