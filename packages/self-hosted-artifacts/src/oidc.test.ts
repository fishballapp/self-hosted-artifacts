import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { beforeAll, describe, expect, it } from 'vitest';
import { ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { clockAt, type Verification } from './test-support.ts';

const ISSUER = 'https://token.actions.githubusercontent.com';
const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;
const NOW = Temporal.Instant.from('2026-06-01T12:00:00Z');
const NOW_SECONDS = NOW.epochMilliseconds / 1000;

const base64url = (bytes: Uint8Array) =>
  bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

const GOOD_CLAIMS = {
  iss: ISSUER,
  aud: 'self-hosted-artifacts',
  nbf: NOW_SECONDS - 10,
  exp: NOW_SECONDS + 300,
  repository: 'fishballapp/private-thing',
  repository_id: '7',
  run_id: '100',
  run_attempt: '2',
  repository_owner_id: '42',
  repository_visibility: 'private',
};

const generateKey = () => crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);

const signRs256 = async (key: CryptoKey, header: object, claims: object) => {
  const signed = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(RSA, key, new TextEncoder().encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
};

const jwkOf = async (key: CryptoKey, kid: string) => ({
  ...(await crypto.subtle.exportKey('jwk', key)),
  kid,
  use: 'sig',
  alg: 'RS256',
});

const CONFIG = {
  storeDir: '/srv/artifacts',
  oidcAudience: 'self-hosted-artifacts',
  oidcRepositoryOwnerId: '42',
  linkBases: { home: 'http://192.0.2.1:8420' },
  host: '127.0.0.1',
  port: 0,
  defaultRetentionDays: 7,
  maxRetentionDays: 30,
  minFreeBytes: 0,
  maxFileBytes: 1024,
};

describe('TokenVerifier', () => {
  let keys: CryptoKeyPair;
  let otherKeys: CryptoKeyPair;

  beforeAll(async () => {
    keys = await generateKey();
    otherKeys = await generateKey();
  });

  const verifierFor = ({
    jwks,
    now = () => NOW,
  }: {
    jwks?: () => Promise<unknown>;
    now?: () => Temporal.Instant;
  } = {}) => {
    const fetchJwks = jwks ?? (async () => ({ keys: [await jwkOf(keys.publicKey, 'key-1')] }));
    const runtime = ManagedRuntime.make(
      TokenVerifier.layer.pipe(
        Layer.provide(Layer.succeed(ServerConfig, CONFIG)),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, async () => Response.json(await fetchJwks())),
        ),
        Layer.provideMerge(clockAt(now)),
      ),
    );
    return (token: string): Promise<Verification> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const verifier = yield* TokenVerifier;
          return yield* verifier.verify(token);
        }).pipe(
          Effect.map(
            ({ repository, scope }): Verification => ({ kind: 'verified', repository, scope }),
          ),
          Effect.catchTags({
            TokenRejectedError: ({ reason }) =>
              Effect.succeed<Verification>({ kind: 'rejected', reason }),
            SigningKeysUnavailableError: ({ reason }) =>
              Effect.succeed<Verification>({ kind: 'unavailable', reason }),
          }),
        ),
      );
  };

  const signGood = (claims: object = GOOD_CLAIMS) =>
    signRs256(keys.privateKey, { alg: 'RS256', typ: 'JWT', kid: 'key-1' }, claims);

  it('accepts a good token and names its repository, run and attempt', async () => {
    expect(await verifierFor()(await signGood())).toEqual({
      kind: 'verified',
      repository: 'fishballapp/private-thing',
      scope: { repositoryId: '7', runId: '100', runAttempt: '2' },
    });
  });

  it('allows a little clock skew either way', async () => {
    const verify = verifierFor();
    const skewed = { ...GOOD_CLAIMS, nbf: NOW_SECONDS + 30, exp: NOW_SECONDS - 30 };
    expect((await verify(await signGood(skewed))).kind).toBe('verified');
  });

  it('rejects a forged signature', async () => {
    const forged = await signRs256(
      otherKeys.privateKey,
      { alg: 'RS256', kid: 'key-1' },
      GOOD_CLAIMS,
    );
    expect(await verifierFor()(forged)).toEqual({ kind: 'rejected', reason: 'bad signature' });
  });

  it('rejects a token whose claims were changed after signing', async () => {
    const [header, , signature] = (await signGood()).split('.');
    const tampered = `${header}.${encodeJson({ ...GOOD_CLAIMS, repository: 'evil/x' })}.${signature}`;
    expect(await verifierFor()(tampered)).toEqual({ kind: 'rejected', reason: 'bad signature' });
  });

  it.each([
    ['empty signature', { alg: 'none', kid: 'key-1' }, ''],
    ['stray signature', { alg: 'none', kid: 'key-1' }, 'AAAA'],
    ['no algorithm', { kid: 'key-1' }, 'AAAA'],
    ['lowercase', { alg: 'rs256', kid: 'key-1' }, 'AAAA'],
  ])('rejects alg none and other non-RS256 headers: %s', async (_, header, signature) => {
    const token = `${encodeJson(header)}.${encodeJson(GOOD_CLAIMS)}.${signature}`;
    expect(await verifierFor()(token)).toEqual({
      kind: 'rejected',
      reason: 'algorithm is not RS256',
    });
  });

  it('rejects an RS256 signature under an alg none header', async () => {
    const token = await signRs256(keys.privateKey, { alg: 'none', kid: 'key-1' }, GOOD_CLAIMS);
    expect((await verifierFor()(token)).kind).toBe('rejected');
  });

  it('rejects HS256, including one signed with the public key as its secret', async () => {
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = `${encodeJson({ alg: 'HS256', kid: 'key-1' })}.${encodeJson(GOOD_CLAIMS)}`;
    const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signed));
    expect(await verifierFor()(`${signed}.${base64url(new Uint8Array(signature))}`)).toEqual({
      kind: 'rejected',
      reason: 'algorithm is not RS256',
    });
  });

  it.each([
    ['expired', { exp: NOW_SECONDS - 61 }, 'expired'],
    ['not yet valid', { nbf: NOW_SECONDS + 61 }, 'not yet valid'],
    ['wrong audience', { aud: 'something-else' }, 'wrong audience'],
    ['audience list', { aud: ['self-hosted-artifacts'] }, 'wrong audience'],
    ['wrong issuer', { iss: 'https://evil.example' }, 'wrong issuer'],
    ['wrong org', { repository_owner_id: '43' }, 'wrong repository owner'],
    ['numeric org', { repository_owner_id: 42 }, 'wrong repository owner'],
    ['public repo', { repository_visibility: 'public' }, 'repository is not private'],
    ['a path as a run', { run_id: '../../etc' }, 'no repository or run claims'],
    ['a numeric attempt', { run_attempt: 2 }, 'no repository or run claims'],
    ['internal repo', { repository_visibility: 'internal' }, 'repository is not private'],
    ['string expiry', { exp: String(NOW_SECONDS + 300) }, 'no expiry'],
  ])('rejects %s', async (_, override, reason) => {
    const verification = await verifierFor()(await signGood({ ...GOOD_CLAIMS, ...override }));
    expect(verification).toEqual({ kind: 'rejected', reason });
  });

  it.each([
    ['iss', 'wrong issuer'],
    ['aud', 'wrong audience'],
    ['exp', 'no expiry'],
    ['nbf', 'no not-before'],
    ['repository', 'no repository or run claims'],
    ['repository_id', 'no repository or run claims'],
    ['run_id', 'no repository or run claims'],
    ['run_attempt', 'no repository or run claims'],
    ['repository_owner_id', 'wrong repository owner'],
    ['repository_visibility', 'repository is not private'],
  ])('rejects a token missing its %s claim', async (claim, reason) => {
    const claims = Object.fromEntries(Object.entries(GOOD_CLAIMS).filter(([key]) => key !== claim));
    expect(await verifierFor()(await signGood(claims))).toEqual({ kind: 'rejected', reason });
  });

  it.each([
    ['not a JWT', 'nonsense'],
    ['too many parts', 'a.b.c.d'],
    ['bad base64', '!!!.!!!.!!!'],
    ['not JSON', `${base64url(new TextEncoder().encode('nope'))}.e30.AAAA`],
    ['array header', `${encodeJson([])}.${encodeJson(GOOD_CLAIMS)}.AAAA`],
  ])('rejects a malformed token: %s', async (_, token) => {
    expect(await verifierFor()(token)).toEqual({ kind: 'rejected', reason: 'malformed token' });
  });

  it('rejects an unknown key ID', async () => {
    const token = await signRs256(keys.privateKey, { alg: 'RS256', kid: 'mystery' }, GOOD_CLAIMS);
    expect(await verifierFor()(token)).toEqual({ kind: 'rejected', reason: 'unknown key ID' });
  });

  it('rejects a token with no key ID', async () => {
    const token = await signRs256(keys.privateKey, { alg: 'RS256' }, GOOD_CLAIMS);
    expect(await verifierFor()(token)).toEqual({ kind: 'rejected', reason: 'no key ID' });
  });

  it('accepts a rotated key by refetching the key set', async () => {
    let now = NOW;
    const served = [
      { keys: [await jwkOf(keys.publicKey, 'key-1')] },
      { keys: [await jwkOf(otherKeys.publicKey, 'key-2')] },
    ];
    let fetches = 0;
    const verify = verifierFor({ jwks: async () => served[fetches++], now: () => now });

    expect((await verify(await signGood())).kind).toBe('verified');

    now = now.add({ seconds: 61 });
    const rotated = await signRs256(
      otherKeys.privateKey,
      { alg: 'RS256', kid: 'key-2' },
      { ...GOOD_CLAIMS, exp: NOW_SECONDS + 600 },
    );
    expect((await verify(rotated)).kind).toBe('verified');
    expect(fetches).toBe(2);
  });

  it('limits refetches with a cooldown, and fetches once for concurrent tokens', async () => {
    let now = NOW;
    let fetches = 0;
    const jwks = { keys: [await jwkOf(keys.publicKey, 'key-1')] };
    const verify = verifierFor({
      jwks: async () => {
        fetches += 1;
        return jwks;
      },
      now: () => now,
    });
    const unknown = await signRs256(keys.privateKey, { alg: 'RS256', kid: 'mystery' }, GOOD_CLAIMS);

    await Promise.all([verify(unknown), verify(unknown), verify(unknown)]);
    expect(fetches).toBe(1);

    await verify(unknown);
    now = now.add({ seconds: 59 });
    await verify(unknown);
    expect(fetches).toBe(1);

    now = now.add({ seconds: 2 });
    await verify(unknown);
    expect(fetches).toBe(2);
  });

  it('answers unavailable when the key set cannot be fetched, then recovers', async () => {
    let now = NOW;
    let isDown = true;
    const jwks = { keys: [await jwkOf(keys.publicKey, 'key-1')] };
    const verify = verifierFor({
      jwks: async () => {
        if (isDown) throw new Error('GitHub is down');
        return jwks;
      },
      now: () => now,
    });
    const token = await signGood();

    expect((await verify(token)).kind).toBe('unavailable');

    isDown = false;
    expect((await verify(token)).kind).toBe('unavailable');

    now = now.add({ seconds: 6 });
    expect((await verify(token)).kind).toBe('verified');
  });

  it('counts a key set of the wrong shape as unavailable', async () => {
    const verify = verifierFor({ jwks: async () => ({ nope: true }) });
    expect((await verify(await signGood())).kind).toBe('unavailable');
  });

  it('starts the cooldown when a slow fetch ends, not when it starts', async () => {
    let now = NOW;
    let fetches = 0;
    const verify = verifierFor({
      jwks: async () => {
        fetches += 1;
        now = now.add({ seconds: 10 });
        throw new Error('GitHub timed out');
      },
      now: () => now,
    });
    const unknown = await signRs256(keys.privateKey, { alg: 'RS256', kid: 'mystery' }, GOOD_CLAIMS);

    await Promise.all([verify(unknown), verify(unknown), verify(unknown)]);
    expect(fetches).toBe(1);
  });

  it('keeps verifying known keys while the key set cannot be fetched', async () => {
    let now = NOW;
    let isDown = false;
    const jwks = { keys: [await jwkOf(keys.publicKey, 'key-1')] };
    const verify = verifierFor({
      jwks: async () => {
        if (isDown) throw new Error('GitHub is down');
        return jwks;
      },
      now: () => now,
    });
    const token = await signGood();
    expect((await verify(token)).kind).toBe('verified');

    isDown = true;
    now = now.add({ seconds: 61 });
    const unknown = await signRs256(keys.privateKey, { alg: 'RS256', kid: 'mystery' }, GOOD_CLAIMS);
    expect((await verify(unknown)).kind).toBe('unavailable');
    expect((await verify(token)).kind).toBe('verified');
  });
});
