import { createHash, createHmac } from 'node:crypto';
import * as Redacted from 'effect/Redacted';
import { uriEncode } from './protocol.ts';

// AWS Signature Version 4 for S3, with no SDK. Pure, so the time is an argument, and AWS's published
// examples hold it in `s3-sigv4.test.ts`.

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** What a streamed body is signed as: its bytes stay out of the signature, and out of memory. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** Seven days, the longest S3 takes for a URL with its signature in it. */
const MAX_PRESIGNED_SECONDS = 7 * 24 * 60 * 60;

export type S3Credentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly sessionToken?: Redacted.Redacted<string>;
};

/** An object's path, encoded per segment. S3 alone isn't encoded twice, unlike other services. */
export const encodeS3Path = (path: string) => path.split('/').map(uriEncode).join('/');

/** Sorted by encoded name, as the signature needs, and so also what goes on the wire. */
export const encodeS3Query = (query: Readonly<Record<string, string>>) =>
  Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

const scopeOf = (date: string, region: string) => `${date}/${region}/s3/aws4_request`;

/** `x-amz-date`'s format: `20130524T000000Z`. */
const amzDateOf = (nowMs: number) => new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/gu, '');

const normaliseHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).map(
      ([name, value]) => [name.toLowerCase(), value.trim().replaceAll(/\s+/gu, ' ')] as const,
    ),
  );

/** The one signature both ways of carrying it hold, over the query and headers as they're sent. */
const signatureOf = ({
  method,
  path,
  query,
  headers,
  payloadHash,
  secretAccessKey,
  amzDate,
  region,
}: {
  method: string;
  path: string;
  query: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  secretAccessKey: Redacted.Redacted<string>;
  amzDate: string;
  region: string;
}) => {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).toSorted();
  const canonicalRequest = [
    method,
    encodeS3Path(path),
    encodeS3Query(query),
    `${names.map(name => `${name}:${headers[name]}`).join('\n')}\n`,
    names.join(';'),
    payloadHash,
  ].join('\n');
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scopeOf(date, region),
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = ['s3', 'aws4_request'].reduce(
    hmac,
    hmac(hmac(`AWS4${Redacted.value(secretAccessKey)}`, date), region),
  );
  return hmac(signingKey, stringToSign).toString('hex');
};

/**
 * The headers to send: the ones given, with their names in lower case, plus `host`, `x-amz-date`,
 * `x-amz-content-sha256`, any session token, and `authorization`. Every one of those is signed.
 */
export const signS3Request = ({
  method,
  host,
  path,
  query = {},
  headers = {},
  payloadHash = UNSIGNED_PAYLOAD,
  credentials: { accessKeyId, secretAccessKey, sessionToken },
  region,
  nowMs,
}: {
  method: string;
  host: string;
  /** Unencoded, starting with `/`. */
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  payloadHash?: string;
  credentials: S3Credentials;
  region: string;
  nowMs: number;
}): Record<string, string> => {
  const amzDate = amzDateOf(nowMs);
  const signed = normaliseHeaders({
    ...headers,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken === undefined ? {} : { 'x-amz-security-token': Redacted.value(sessionToken) }),
  });
  const signature = signatureOf({
    method,
    path,
    query,
    headers: signed,
    payloadHash,
    secretAccessKey,
    amzDate,
    region,
  });
  return {
    ...signed,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scopeOf(amzDate.slice(0, 8), region)}, SignedHeaders=${Object.keys(signed).toSorted().join(';')}, Signature=${signature}`,
  };
};

/**
 * The encoded query of a URL anyone can use until it expires, with the signature in it. `headers`
 * are signed along with `host`, so whoever sends the request has to send exactly those, and the body
 * stays out of the signature.
 */
export const presignS3Request = ({
  method,
  host,
  path,
  query = {},
  headers = {},
  credentials: { accessKeyId, secretAccessKey, sessionToken },
  region,
  nowMs,
  expiresInSeconds,
}: {
  method: string;
  host: string;
  /** Unencoded, starting with `/`. */
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  credentials: S3Credentials;
  region: string;
  nowMs: number;
  expiresInSeconds: number;
}) => {
  if (expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGNED_SECONDS) {
    throw new RangeError(`S3 takes 1 to ${MAX_PRESIGNED_SECONDS} seconds, not ${expiresInSeconds}`);
  }
  const amzDate = amzDateOf(nowMs);
  const signed = normaliseHeaders({ ...headers, host });
  const signedQuery = {
    ...query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scopeOf(amzDate.slice(0, 8), region)}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    ...(sessionToken === undefined ? {} : { 'X-Amz-Security-Token': Redacted.value(sessionToken) }),
    'X-Amz-SignedHeaders': Object.keys(signed).toSorted().join(';'),
  };
  const signature = signatureOf({
    method,
    path,
    query: signedQuery,
    headers: signed,
    payloadHash: UNSIGNED_PAYLOAD,
    secretAccessKey,
    amzDate,
    region,
  });
  return encodeS3Query({ ...signedQuery, 'X-Amz-Signature': signature });
};
