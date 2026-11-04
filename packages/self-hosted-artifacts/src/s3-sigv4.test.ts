import * as Redacted from 'effect/Redacted';
import { describe, expect, it } from 'vitest';
import { presignS3Request, signS3Request } from './s3-sigv4.ts';

// The examples of "Signature Calculations for the Authorization Header: Transferring Payload in a
// Single Chunk" in the Amazon S3 API Reference: same keys, same time, same signatures.
const EXAMPLE = {
  host: 'examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  nowMs: Date.UTC(2013, 4, 24),
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: Redacted.make('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  },
};
const EMPTY_PAYLOAD = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const credentialOf = 'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request';

describe('AWS published examples', () => {
  it('signs GET Object', () => {
    const headers = signS3Request({
      ...EXAMPLE,
      method: 'GET',
      path: '/test.txt',
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_PAYLOAD,
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 ${credentialOf}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    );
  });

  it('signs PUT Object, encoding what the path holds', () => {
    const headers = signS3Request({
      ...EXAMPLE,
      method: 'PUT',
      path: '/test$file.text',
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 ${credentialOf}, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd`,
    );
  });

  it('signs GET Bucket Lifecycle, with a query parameter that has no value', () => {
    const headers = signS3Request({
      ...EXAMPLE,
      method: 'GET',
      path: '/',
      query: { lifecycle: '' },
      payloadHash: EMPTY_PAYLOAD,
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 ${credentialOf}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`,
    );
  });

  it('signs Get Bucket (List Objects), sorting its query', () => {
    const headers = signS3Request({
      ...EXAMPLE,
      method: 'GET',
      path: '/',
      query: { prefix: 'J', 'max-keys': '2' },
      payloadHash: EMPTY_PAYLOAD,
    });
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 ${credentialOf}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`,
    );
  });
});

describe('what the client relies on', () => {
  it('signs a session token, and changes the signature with it', () => {
    const withoutToken = signS3Request({ ...EXAMPLE, method: 'GET', path: '/a' });
    const withToken = signS3Request({
      ...EXAMPLE,
      credentials: { ...EXAMPLE.credentials, sessionToken: Redacted.make('the-session') },
      method: 'GET',
      path: '/a',
    });
    expect(withToken['x-amz-security-token']).toBe('the-session');
    expect(withToken.authorization).toContain('x-amz-date;x-amz-security-token');
    expect(withToken.authorization).not.toBe(withoutToken.authorization);
  });

  it('signs a conditional header, so a proxy can not drop it', () => {
    const { authorization } = signS3Request({
      ...EXAMPLE,
      method: 'PUT',
      path: '/a',
      headers: { 'If-None-Match': '*' },
    });
    expect(authorization).toContain('SignedHeaders=host;if-none-match;x-amz-content-sha256');
  });

  it('never holds the secret in what it sends', () => {
    const sent = JSON.stringify(signS3Request({ ...EXAMPLE, method: 'GET', path: '/a' }));
    expect(sent).not.toContain('wJalrXUtnFEMI');
  });

  it('marks a streamed body unsigned', () => {
    const headers = signS3Request({ ...EXAMPLE, method: 'PUT', path: '/a' });
    expect(headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });
});

describe('a URL that holds its signature', () => {
  // "Authenticating Requests: Using Query Parameters" in the Amazon S3 API Reference: same keys, same
  // time, same signature.
  it("reproduces AWS's published example", () => {
    expect(
      presignS3Request({
        ...EXAMPLE,
        method: 'GET',
        path: '/test.txt',
        expiresInSeconds: 86_400,
      }),
    ).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&X-Amz-SignedHeaders=host',
    );
  });

  const presign = (overrides: Partial<Parameters<typeof presignS3Request>[0]> = {}) =>
    new URLSearchParams(
      presignS3Request({
        ...EXAMPLE,
        method: 'PUT',
        path: '/a',
        expiresInSeconds: 3600,
        ...overrides,
      }),
    );

  it('signs every header given, sorted, with its name in lower case', () => {
    const signed = presign({ headers: { 'Content-Length': '1', 'x-amz-meta-run-scope': '7/1/1' } });
    expect(signed.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-meta-run-scope');
  });

  it('changes with each thing it binds', () => {
    const signatureOf = (overrides: Parameters<typeof presign>[0]) =>
      presign(overrides).get('X-Amz-Signature');
    const base = signatureOf({ headers: { 'content-length': '1' } });
    expect(signatureOf({ headers: { 'content-length': '2' } })).not.toBe(base);
    expect(signatureOf({ headers: { 'content-length': '1' }, path: '/b' })).not.toBe(base);
    expect(signatureOf({ headers: { 'content-length': '1' }, method: 'GET' })).not.toBe(base);
    expect(signatureOf({ headers: { 'content-length': '1' }, expiresInSeconds: 60 })).not.toBe(
      base,
    );
  });

  it('puts a session token in the query, signed', () => {
    const withToken = presign({
      credentials: { ...EXAMPLE.credentials, sessionToken: Redacted.make('the-session') },
    });
    expect(withToken.get('X-Amz-Security-Token')).toBe('the-session');
    expect(withToken.get('X-Amz-Signature')).not.toBe(presign().get('X-Amz-Signature'));
  });

  it('signs a query it is given, encoded as S3 reads it', () => {
    const query = { 'response-content-disposition': 'attachment; filename="a.zip"' };
    expect(
      presignS3Request({ ...EXAMPLE, method: 'GET', path: '/a', query, expiresInSeconds: 60 }),
    ).toContain('response-content-disposition=attachment%3B%20filename%3D%22a.zip%22');
    expect(presign({ query }).get('X-Amz-Signature')).not.toBe(presign().get('X-Amz-Signature'));
  });

  it('never holds the secret', () => {
    expect(presign().toString()).not.toContain('wJalrXUtnFEMI');
  });

  it.each([0, 604_801])('refuses to last %i seconds, as S3 would', expiresInSeconds => {
    expect(() => presign({ expiresInSeconds })).toThrow(RangeError);
  });

  it('takes seven days', () => {
    expect(presign({ expiresInSeconds: 604_800 }).get('X-Amz-Expires')).toBe('604800');
  });
});
