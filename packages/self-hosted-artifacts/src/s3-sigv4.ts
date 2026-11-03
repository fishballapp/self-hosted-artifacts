import { createHash, createHmac } from 'node:crypto';
import * as Redacted from 'effect/Redacted';

// AWS Signature Version 4 for S3, with no SDK. Pure, so the time is an argument, and AWS's published
// examples hold it in `s3-sigv4.test.ts`.

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** What a streamed body is signed as: its bytes stay out of the signature, and out of memory. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export type S3Credentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly sessionToken?: Redacted.Redacted<string>;
};

/** RFC 3986, as SigV4 has it: `encodeURIComponent` plus the four characters it leaves alone. */
const uriEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!*'()]/gu,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

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

const signatureOf = ({
  secretAccessKey,
  date,
  region,
  stringToSign,
}: {
  secretAccessKey: string;
  date: string;
  region: string;
  stringToSign: string;
}) => {
  const signingKey = ['s3', 'aws4_request'].reduce(
    hmac,
    hmac(hmac(`AWS4${secretAccessKey}`, date), region),
  );
  return hmac(signingKey, stringToSign).toString('hex');
};

/** `x-amz-date`'s format: `20130524T000000Z`. */
const amzDateOf = (nowMs: number) => new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/gu, '');

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
  const date = amzDate.slice(0, 8);
  const signed = Object.fromEntries(
    Object.entries({
      ...headers,
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(sessionToken === undefined
        ? {}
        : { 'x-amz-security-token': Redacted.value(sessionToken) }),
    }).map(([name, value]) => [name.toLowerCase(), value.trim().replaceAll(/\s+/gu, ' ')] as const),
  );
  const names = Object.keys(signed).toSorted();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method,
    encodeS3Path(path),
    encodeS3Query(query),
    `${names.map(name => `${name}:${signed[name]}`).join('\n')}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = signatureOf({
    secretAccessKey: Redacted.value(secretAccessKey),
    date,
    region,
    stringToSign,
  });
  return {
    ...signed,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
