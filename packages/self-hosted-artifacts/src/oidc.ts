import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import { ServerConfig } from './config.ts';

const ISSUER = 'https://token.actions.githubusercontent.com';
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const CLOCK_LEEWAY_SECONDS = 60;
const JWKS_FETCH_TIMEOUT = Duration.seconds(10);
const REFETCH_COOLDOWN_MS = 60_000;
// Short, so an upload's retries outlast a failed fetch; long enough that bad tokens can't hammer.
const REFETCH_COOLDOWN_AFTER_FAILURE_MS = 5_000;

/** The token isn't one to accept. `reason` is for the log; the client sees a generic message. */
export class TokenRejectedError extends Schema.TaggedError<TokenRejectedError>()(
  'TokenRejectedError',
  { reason: Schema.String },
) {}

/** GitHub's signing keys can't be fetched, so the token can't be judged either way. */
export class SigningKeysUnavailableError extends Schema.TaggedError<SigningKeysUnavailableError>()(
  'SigningKeysUnavailableError',
  { reason: Schema.String },
) {}

const JwksSchema = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });

const RsaJwkSchema = Schema.Struct({
  kid: Schema.String,
  kty: Schema.String,
  n: Schema.String,
  e: Schema.String,
});

const decodeRsaJwk = (jwk: unknown) => Schema.decodeUnknownOption(RsaJwkSchema)(jwk);
const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const importKey = ({ kid, kty, n, e }: typeof RsaJwkSchema.Type) =>
  Effect.promise(() =>
    crypto.subtle
      .importKey('jwk', { kty, n, e }, RSA, false, ['verify'])
      .then((key): Option.Option<readonly [string, CryptoKey]> => Option.some([kid, key]))
      .catch(() => Option.none()),
  );

const importKeys = Effect.fnUntraced(function* (jwks: typeof JwksSchema.Type) {
  const imported = yield* Effect.forEach(Arr.getSomes(jwks.keys.map(decodeRsaJwk)), importKey, {
    concurrency: 'unbounded',
  });
  return new Map(Arr.getSomes(imported));
});

const decodeBase64url = (part: string) => Uint8Array.fromBase64(part, { alphabet: 'base64url' });

const parseJwt = (token: string) => {
  const [header, claims, signature, ...rest] = token.split('.');
  if (header === undefined || claims === undefined || signature === undefined) return undefined;
  if (rest.length > 0) return undefined;
  const decodeJson = (part: string) =>
    decodeJsonObject(new TextDecoder().decode(decodeBase64url(part)));
  try {
    const decodedHeader = decodeJson(header);
    const decodedClaims = decodeJson(claims);
    if (Option.isNone(decodedHeader) || Option.isNone(decodedClaims)) return undefined;
    return {
      header: decodedHeader.value,
      claims: decodedClaims.value,
      signature: decodeBase64url(signature),
      signed: new TextEncoder().encode(`${header}.${claims}`),
    };
  } catch {
    return undefined;
  }
};

const findClaimProblem = (
  claims: Readonly<Record<string, unknown>>,
  {
    audience,
    repositoryOwnerId,
    nowSeconds,
  }: { audience: string; repositoryOwnerId: string; nowSeconds: number },
): string | undefined => {
  if (claims.iss !== ISSUER) return 'wrong issuer';
  if (claims.aud !== audience) return 'wrong audience';
  if (!Predicate.isNumber(claims.exp)) return 'no expiry';
  if (!Predicate.isNumber(claims.nbf)) return 'no not-before';
  if (nowSeconds >= claims.exp + CLOCK_LEEWAY_SECONDS) return 'expired';
  if (nowSeconds < claims.nbf - CLOCK_LEEWAY_SECONDS) return 'not yet valid';
  if (claims.repository_owner_id !== repositoryOwnerId) return 'wrong repository owner';
  if (claims.repository_visibility !== 'private') return 'repository is not private';
  return undefined;
};

/** Verifies a GitHub Actions OIDC token, over the key set it caches from GitHub. */
export class TokenVerifier extends Context.Service<
  TokenVerifier,
  {
    readonly verify: (
      token: string,
    ) => Effect.Effect<
      { readonly repository: string },
      TokenRejectedError | SigningKeysUnavailableError
    >;
  }
>()('self-hosted-artifacts/TokenVerifier') {
  static readonly layer = Layer.effect(
    TokenVerifier,
    Effect.gen(function* () {
      const { oidcAudience: audience, oidcRepositoryOwnerId: repositoryOwnerId } =
        yield* ServerConfig;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const keys = yield* Ref.make(new Map<string, CryptoKey>());
      const lastFetch = yield* Ref.make(Option.none<{ atMs: number; isOk: boolean }>());
      // One fetch at a time: those waiting then see its result and sit out the cooldown.
      const fetching = yield* Semaphore.make(1);

      const fetchKeys = client
        .get(`${ISSUER}/.well-known/jwks`)
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(JwksSchema)),
          Effect.flatMap(importKeys),
          Effect.timeout(JWKS_FETCH_TIMEOUT),
        );

      const refreshKeys = fetching.withPermit(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const isCoolingDown = Option.exists(
            yield* Ref.get(lastFetch),
            ({ atMs, isOk }) =>
              nowMs - atMs < (isOk ? REFETCH_COOLDOWN_MS : REFETCH_COOLDOWN_AFTER_FAILURE_MS),
          );
          if (isCoolingDown) return;
          const fetched = yield* Effect.option(fetchKeys);
          // From when the fetch ended: one that timed out has otherwise already sat out its cooldown.
          const atMs = yield* Clock.currentTimeMillis;
          yield* Ref.set(lastFetch, Option.some({ atMs, isOk: Option.isSome(fetched) }));
          if (Option.isSome(fetched)) yield* Ref.set(keys, fetched.value);
        }),
      );

      const reject = (reason: string) => Effect.fail(new TokenRejectedError({ reason }));

      return TokenVerifier.of({
        verify: Effect.fn('TokenVerifier.verify')(function* (token) {
          const jwt = parseJwt(token);
          if (jwt === undefined) return yield* reject('malformed token');
          const { header, claims, signature, signed } = jwt;
          if (header.alg !== 'RS256') return yield* reject('algorithm is not RS256');
          const { kid } = header;
          if (!Predicate.isString(kid)) return yield* reject('no key ID');

          if (!(yield* Ref.get(keys)).has(kid)) yield* refreshKeys;
          const key = (yield* Ref.get(keys)).get(kid);
          if (key === undefined) {
            const fetchFailed = Option.exists(yield* Ref.get(lastFetch), ({ isOk }) => !isOk);
            return yield* fetchFailed
              ? new SigningKeysUnavailableError({ reason: 'could not fetch the JWKS' })
              : new TokenRejectedError({ reason: 'unknown key ID' });
          }

          const isSigned = yield* Effect.promise(() =>
            crypto.subtle.verify(RSA, key, signature, signed).catch(() => false),
          );
          if (!isSigned) return yield* reject('bad signature');

          const nowMs = yield* Clock.currentTimeMillis;
          const problem = findClaimProblem(claims, {
            audience,
            repositoryOwnerId,
            nowSeconds: nowMs / 1000,
          });
          if (problem !== undefined) return yield* reject(problem);
          const { repository } = claims;
          if (!Predicate.isString(repository)) return yield* reject('no repository claim');
          return { repository };
        }),
      });
    }),
  );
}
