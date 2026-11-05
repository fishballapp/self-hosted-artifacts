import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as Redacted from 'effect/Redacted';
import { unescapeXml } from './s3-bucket.ts';
import {
  encodeS3Path,
  encodeS3Query,
  presignS3Request,
  type S3Credentials,
  signS3Request,
} from './s3-sigv4.ts';
import { closeServer, listenOnLoopback } from './test-support.ts';

/** What the tests sign with: never a real credential. */
export const FAKE_ACCESS_KEY_ID = 'FAKEACCESSKEYID';
export const FAKE_SECRET_ACCESS_KEY = 'fake-secret-access-key';

type StoredObject = {
  /** In order: an upload in parts stays as its parts. */
  readonly files: readonly string[];
  readonly etag: string;
  readonly size: number;
  readonly headers: Readonly<Record<string, string>>;
};

type UploadedPart = { readonly file: string; readonly etag: string; readonly size: number };

type PendingUpload = {
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly parts: Map<number, UploadedPart>;
};

const MIN_PART_BYTES = 5 * 1024 ** 2;
const MAX_PART_NUMBER = 10_000;

const errorXml = (code: string, message: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message>${extra}</Error>`;

const respondError = (
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra = '',
) =>
  void res
    .writeHead(status, { 'content-type': 'application/xml' })
    .end(errorXml(code, message, extra));

const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    // As MinIO does.
    .replaceAll('"', '&#34;')
    .replaceAll("'", '&#39;');

const metadataOf = (req: IncomingMessage) =>
  Object.fromEntries(
    Object.entries(req.headers).flatMap(([name, value]) =>
      (name === 'content-type' ||
        name === 'content-disposition' ||
        name.startsWith('x-amz-meta-')) &&
      typeof value === 'string'
        ? [[name, value] as const]
        : [],
    ),
  );

const headerOf = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

const signatureIsValid = (req: IncomingMessage, url: URL, path: string) => {
  const authorization = headerOf(req, 'authorization') ?? '';
  const parts =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$/u.exec(
      authorization,
    );
  const [, accessKeyId, region, signedHeaders] = parts ?? [];
  const amzDate = headerOf(req, 'x-amz-date') ?? '';
  if (accessKeyId !== FAKE_ACCESS_KEY_ID || region === undefined || signedHeaders === undefined) {
    return false;
  }
  const nowMs = millisOfAmzDate(amzDate);
  if (nowMs === undefined) return false;
  const names = signedHeaders.split(';');
  // The bare minimum of what a real store insists on.
  if (!names.includes('host') || !names.includes('x-amz-date')) return false;
  const credentials: S3Credentials = {
    accessKeyId,
    secretAccessKey: Redacted.make(FAKE_SECRET_ACCESS_KEY),
  };
  const expected = signS3Request({
    method: req.method ?? '',
    host: headerOf(req, 'host') ?? '',
    path,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(
      names
        .filter(name => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name))
        .map(name => [name, headerOf(req, name) ?? ''] as const),
    ),
    payloadHash: headerOf(req, 'x-amz-content-sha256') ?? '',
    credentials,
    region,
    nowMs,
  });
  return (
    expected.authorization === authorization &&
    // An `x-amz-security-token` the client sends has to be among what it signed.
    (headerOf(req, 'x-amz-security-token') === undefined || names.includes('x-amz-security-token'))
  );
};

const millisOfAmzDate = (amzDate: string) => {
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(amzDate);
  if (parts === null) return undefined;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second);
};

/**
 * Why a URL with a signature in it is refused, as R2 was measured refusing one: a signed header that
 * is missing or changed, the length among them, breaks the signature, and only `GET` and `PUT` work.
 */
const presignedRefusal = (req: IncomingMessage, url: URL, path: string) => {
  const signatureFailure = { code: 'SignatureDoesNotMatch', message: 'Signature mismatch' };
  if (req.method !== 'GET' && req.method !== 'PUT') return signatureFailure;
  const { searchParams: params } = url;
  const [, accessKeyId, date, region] =
    /^([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request$/u.exec(params.get('X-Amz-Credential') ?? '') ??
    [];
  const nowMs = millisOfAmzDate(params.get('X-Amz-Date') ?? '');
  const expiresInSeconds = Number(params.get('X-Amz-Expires'));
  if (accessKeyId !== FAKE_ACCESS_KEY_ID || region === undefined || nowMs === undefined) {
    return signatureFailure;
  }
  if (date !== params.get('X-Amz-Date')?.slice(0, 8)) return signatureFailure;
  const names = (params.get('X-Amz-SignedHeaders') ?? '').split(';');
  if (!names.includes('host')) return signatureFailure;
  const sessionToken = params.get('X-Amz-Security-Token');
  const expected = new URLSearchParams(
    presignS3Request({
      method: req.method,
      host: headerOf(req, 'host') ?? '',
      path,
      query: Object.fromEntries([...params].filter(([name]) => !name.startsWith('X-Amz-'))),
      headers: Object.fromEntries(
        names
          .filter(name => name !== 'host')
          .map(name => [name, headerOf(req, name) ?? ''] as const),
      ),
      credentials: {
        accessKeyId,
        secretAccessKey: Redacted.make(FAKE_SECRET_ACCESS_KEY),
        ...(sessionToken === null ? {} : { sessionToken: Redacted.make(sessionToken) }),
      },
      region,
      nowMs,
      expiresInSeconds,
    }),
  );
  const isUnsignedAmzHeader = Object.keys(req.headers).some(
    name => name.startsWith('x-amz-') && !names.includes(name),
  );
  if (expected.get('X-Amz-Signature') !== params.get('X-Amz-Signature') || isUnsignedAmzHeader) {
    return signatureFailure;
  }
  return Date.now() >= nowMs + expiresInSeconds * 1000
    ? { code: 'ExpiredRequest', message: 'The request has expired' }
    : undefined;
};

/**
 * A small S3 on a loopback socket, in path style: checks each signature, in a header or a URL,
 * honours conditional writes, checksums, listing and uploads in parts, and keeps
 * `Content-Disposition`, as `s3-sigv4.test.ts` holds the signer to AWS's own examples. It answers a
 * `GET` that accepts gzip with a weak ETag, as R2 does. Anonymous reads get what the README's bucket
 * policy gives them, or nothing from a private bucket.
 *
 * Parts follow R2's documented rule, the stricter: all but the last the same size. AWS takes any. That,
 * and the code it answers with, come from the docs, as nothing here has been measured on R2.
 */
export const startFakeS3 = async ({ isPublic = true }: { isPublic?: boolean } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-s3-'));
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, PendingUpload>();
  let nextFile = 0;
  let pageSize = 1000;

  const putObject = async (req: IncomingMessage, res: ServerResponse, key: string) => {
    const length = headerOf(req, 'content-length');
    if (length === undefined) {
      req.resume();
      return respondError(res, 411, 'MissingContentLength', 'You must provide the Content-Length.');
    }
    const file = join(directory, String(nextFile++));
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    req.on('data', chunk => {
      sha256.update(chunk);
      md5.update(chunk);
    });
    await pipeline(req, createWriteStream(file));

    const checksum = headerOf(req, 'x-amz-checksum-sha256');
    if (checksum !== undefined && checksum !== sha256.digest('base64')) {
      return respondError(
        res,
        400,
        'BadDigest',
        'The SHA256 you specified did not match the calculated checksum.',
      );
    }
    // After the body, as the first of two conditional writes to finish is the one that wins.
    const held = objects.get(key);
    const ifNoneMatch = headerOf(req, 'if-none-match');
    const ifMatch = headerOf(req, 'if-match');
    if (ifNoneMatch === '*' && held !== undefined) {
      return respondError(
        res,
        412,
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
      );
    }
    if (ifMatch !== undefined) {
      if (held === undefined) {
        return respondError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      }
      if (ifMatch !== held.etag) {
        return respondError(
          res,
          412,
          'PreconditionFailed',
          'At least one of the pre-conditions you specified did not hold',
        );
      }
    }
    const etag = `"${md5.digest('hex')}"`;
    objects.set(key, { files: [file], etag, size: Number(length), headers: metadataOf(req) });
    return void res.writeHead(200, { etag }).end();
  };

  const noSuchUpload = (res: ServerResponse) =>
    respondError(
      res,
      404,
      'NoSuchUpload',
      'The specified multipart upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.',
    );

  const createUpload = (req: IncomingMessage, res: ServerResponse, key: string) => {
    const uploadId = randomBytes(32).toString('base64url');
    uploads.set(uploadId, { key, headers: metadataOf(req), parts: new Map() });
    return void res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
  };

  const putPart = async (req: IncomingMessage, res: ServerResponse, key: string, url: URL) => {
    const upload = uploads.get(url.searchParams.get('uploadId') ?? '');
    const partNumber = Number(url.searchParams.get('partNumber'));
    if (upload?.key !== key) {
      req.resume();
      return noSuchUpload(res);
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      req.resume();
      return respondError(res, 400, 'InvalidArgument', 'Part number must be 1 to 10000.');
    }
    const file = join(directory, String(nextFile++));
    const md5 = createHash('md5');
    let size = 0;
    req.on('data', chunk => {
      md5.update(chunk);
      size += chunk.length;
    });
    await pipeline(req, createWriteStream(file));
    const digest = md5.digest();
    const contentMd5 = headerOf(req, 'content-md5');
    if (contentMd5 !== undefined && contentMd5 !== digest.toString('base64')) {
      return respondError(res, 400, 'BadDigest', 'The Content-MD5 you specified did not match.');
    }
    const etag = `"${digest.toString('hex')}"`;
    upload.parts.set(partNumber, { file, etag, size });
    return void res.writeHead(200, { etag }).end();
  };

  const completeUpload = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const uploadId = url.searchParams.get('uploadId') ?? '';
    const xml = Buffer.concat(await Array.fromAsync(req)).toString();
    const upload = uploads.get(uploadId);
    if (upload === undefined) return noSuchUpload(res);
    const named = Array.from(
      xml.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/gu),
      ([, partNumber, etag]) => ({
        partNumber: Number(partNumber),
        etag: unescapeXml(etag ?? ''),
      }),
    );
    const isInOrder = named.every(
      ({ partNumber }, index) => index === 0 || partNumber > (named[index - 1]?.partNumber ?? 0),
    );
    if (named.length === 0 || !isInOrder) {
      return respondError(res, 400, 'InvalidPartOrder', 'The list of parts was not in order.');
    }
    const parts = named.map(({ partNumber, etag }) => {
      const part = upload.parts.get(partNumber);
      return part?.etag === etag ? part : undefined;
    });
    if (parts.includes(undefined)) {
      return respondError(res, 400, 'InvalidPart', 'One or more of the parts could not be found.');
    }
    const sizes = parts.map(part => part?.size ?? 0);
    const [first = 0] = sizes;
    const allButLast = sizes.slice(0, -1);
    if (allButLast.some(size => size < MIN_PART_BYTES)) {
      return respondError(res, 400, 'EntityTooSmall', 'A part is smaller than the minimum.');
    }
    if (allButLast.some(size => size !== first) || (sizes.at(-1) ?? 0) > first) {
      return respondError(res, 400, 'InvalidPart', 'All parts but the last must be the same size.');
    }
    const etagOfEtags = createHash('md5');
    for (const part of parts) etagOfEtags.update(Buffer.from(part?.etag.slice(1, -1) ?? '', 'hex'));
    const etag = `"${etagOfEtags.digest('hex')}-${parts.length}"`;
    objects.set(upload.key, {
      files: parts.map(part => part?.file ?? ''),
      etag,
      size: sizes.reduce((total, size) => total + size, 0),
      headers: upload.headers,
    });
    uploads.delete(uploadId);
    return void res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${escapeXml(upload.key)}</Key><ETag>${escapeXml(etag)}</ETag></CompleteMultipartUploadResult>`,
      );
  };

  const listUploads = (res: ServerResponse) =>
    void res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult>${[...uploads.values()]
          .map(({ key }) => `<Upload><Key>${escapeXml(key)}</Key></Upload>`)
          .join('')}</ListMultipartUploadsResult>`,
      );

  const getObject = (
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    isAnonymous: boolean,
    disposition: string | null = null,
  ) => {
    const held = objects.get(key);
    if (held === undefined) {
      // With no permission to list, S3 won't say whether a key exists.
      return isAnonymous
        ? respondError(res, 403, 'AccessDenied', 'Access Denied')
        : respondError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    }
    const acceptsGzip = headerOf(req, 'accept-encoding')?.includes('gzip') === true;
    const headers = {
      ...held.headers,
      ...(disposition === null ? {} : { 'content-disposition': disposition }),
      'content-length': String(held.size),
      etag: acceptsGzip ? `W/${held.etag}` : held.etag,
    };
    if (req.method === 'HEAD') return void res.writeHead(200, headers).end();
    res.writeHead(200, headers);
    return void (async () => {
      for (const file of held.files) {
        for await (const chunk of createReadStream(file)) {
          if (!res.write(chunk)) await once(res, 'drain');
        }
      }
      res.end();
    })().catch(() => res.destroy());
  };

  const listObjects = (res: ServerResponse, url: URL) => {
    const prefix = url.searchParams.get('prefix') ?? '';
    const maxKeys = Math.min(Number(url.searchParams.get('max-keys') ?? pageSize), pageSize);
    const token = url.searchParams.get('continuation-token');
    const after =
      token === null ? '' : Buffer.from(token.replace(/^t&/u, ''), 'base64url').toString();
    const keys = Array.from(objects.keys())
      .filter(key => key.startsWith(prefix) && key > after)
      .toSorted();
    const page = keys.slice(0, maxKeys);
    const last = page.at(-1);
    const isTruncated = keys.length > page.length && last !== undefined;
    // A token that needs unescaping, as real ones may.
    const next = isTruncated ? `t&${Buffer.from(last).toString('base64url')}` : '';
    return void res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><KeyCount>${page.length}</KeyCount><IsTruncated>${isTruncated}</IsTruncated>${
          isTruncated ? `<NextContinuationToken>${escapeXml(next)}</NextContinuationToken>` : ''
        }${page.map(key => `<Contents><Key>${escapeXml(key)}</Key><Size>0</Size></Contents>`).join('')}</ListBucketResult>`,
      );
  };

  /** A client gone partway through a body, which a store drops, as it does the connection. */
  const droppingOnFailure = (res: ServerResponse, work: Promise<void>) =>
    void work.catch(() => res.destroy());

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://fake');
    const [, , ...keySegments] = url.pathname.split('/').map(decodeURIComponent);
    const key = keySegments.join('/');
    const isAnonymous = headerOf(req, 'authorization') === undefined;
    const path = url.pathname.split('/').map(decodeURIComponent).join('/');
    const isListing = key === '';

    if (url.searchParams.has('X-Amz-Signature')) {
      const refusal = presignedRefusal(req, url, path);
      if (refusal !== undefined) {
        req.resume();
        return respondError(res, 403, refusal.code, refusal.message);
      }
      if (req.method === 'PUT') {
        return droppingOnFailure(
          res,
          url.searchParams.has('partNumber')
            ? putPart(req, res, key, url)
            : putObject(req, res, key),
        );
      }
      return getObject(req, res, key, false, url.searchParams.get('response-content-disposition'));
    }
    if (isAnonymous) {
      // The README's policy: anonymous `GetObject` on `artifacts/*`, and nothing else.
      if (!isPublic || req.method !== 'GET' || isListing || !key.startsWith('artifacts/')) {
        req.resume();
        return respondError(res, 403, 'AccessDenied', 'Access Denied');
      }
      return getObject(req, res, key, true);
    }
    if (!signatureIsValid(req, url, path)) {
      req.resume();
      return respondError(
        res,
        403,
        'SignatureDoesNotMatch',
        'The request signature we calculated does not match the signature you provided.',
        // As S3's does, which a client must not pass on.
        `<AWSAccessKeyId>${FAKE_ACCESS_KEY_ID}</AWSAccessKeyId><StringToSign>the string</StringToSign>`,
      );
    }
    if (isListing && req.method === 'GET') {
      return url.searchParams.has('uploads') ? listUploads(res) : listObjects(res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return getObject(req, res, key, false);
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      return createUpload(req, res, key);
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      return droppingOnFailure(res, completeUpload(req, res, url));
    }
    if (req.method === 'PUT') {
      return droppingOnFailure(
        res,
        url.searchParams.has('partNumber') ? putPart(req, res, key, url) : putObject(req, res, key),
      );
    }
    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId') ?? '';
      if (uploads.get(uploadId)?.key !== key) return noSuchUpload(res);
      uploads.delete(uploadId);
      return void res.writeHead(204).end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return void res.writeHead(204).end();
    }
    return respondError(res, 405, 'MethodNotAllowed', 'Method Not Allowed');
  });

  return {
    endpoint: await listenOnLoopback(server),
    objectHeaders: (key: string) => objects.get(key)?.headers,
    /** Short pages, to hold a client to following them. */
    limitPagesTo: (keys: number) => {
      pageSize = keys;
    },
    stop: async () => {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** Signed requests to a bucket, for what a test does behind the client's back. */
export const rawS3Client = ({
  endpoint,
  bucket,
  credentials,
  region,
}: {
  endpoint: string;
  bucket: string;
  credentials: S3Credentials;
  region: string;
}) => {
  const { host, origin } = new URL(endpoint);
  const send = (
    method: string,
    key: string,
    {
      query = {},
      headers = {},
      body,
    }: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: BodyInit;
    } = {},
  ) => {
    const path = `/${bucket}/${key}`;
    const { host: _host, ...signed } = signS3Request({
      method,
      host,
      path,
      query,
      headers,
      credentials,
      region,
      nowMs: Date.now(),
    });
    const search = encodeS3Query(query);
    return fetch(`${origin}${encodeS3Path(path)}${search === '' ? '' : `?${search}`}`, {
      method,
      headers: signed,
      ...(body === undefined ? {} : { body }),
    });
  };
  return {
    send,
    /** Every key under a prefix, for looking at what's left. */
    keys: async (prefix = '') => {
      const xml = await (await send('GET', '', { query: { 'list-type': '2', prefix } })).text();
      return Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/gu), ([, key = '']) => unescapeXml(key));
    },
    /** The keys of what's been started in parts and neither finished nor stopped. */
    pendingUploads: async () => {
      const xml = await (await send('GET', '', { query: { uploads: '' } })).text();
      return Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/gu), ([, key = '']) => unescapeXml(key));
    },
  };
};
