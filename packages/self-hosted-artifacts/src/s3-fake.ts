import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as Redacted from 'effect/Redacted';
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
  readonly file: string;
  readonly etag: string;
  readonly size: number;
  readonly headers: Readonly<Record<string, string>>;
};

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

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

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
 * honours conditional writes, checksums and listing, and keeps `Content-Disposition`, as
 * `s3-sigv4.test.ts` holds the signer to AWS's own examples. It answers a `GET` that accepts gzip with
 * a weak ETag, as R2 does. Anonymous reads get what the README's bucket policy gives them, or nothing
 * from a private bucket.
 */
export const startFakeS3 = async ({ isPublic = true }: { isPublic?: boolean } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-s3-'));
  const objects = new Map<string, StoredObject>();
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
    objects.set(key, {
      file,
      etag,
      size: Number(length),
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) =>
          (name === 'content-type' ||
            name === 'content-disposition' ||
            name.startsWith('x-amz-meta-')) &&
          typeof value === 'string'
            ? [[name, value] as const]
            : [],
        ),
      ),
    });
    return void res.writeHead(200, { etag }).end();
  };

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
    return void createReadStream(held.file).pipe(res);
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
      if (req.method === 'PUT') return void putObject(req, res, key);
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
    if (isListing && req.method === 'GET') return listObjects(res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return getObject(req, res, key, false);
    if (req.method === 'PUT') return void putObject(req, res, key);
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
      return Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/gu), ([, key = '']) => key);
    },
  };
};
