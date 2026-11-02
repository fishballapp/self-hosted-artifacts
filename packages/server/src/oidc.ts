const ISSUER = 'https://token.actions.githubusercontent.com';
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const CLOCK_LEEWAY_SECONDS = 60;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const REFETCH_COOLDOWN_MS = 60_000;
// Short, so an upload's retries outlast a failed fetch; long enough that bad tokens can't hammer.
const REFETCH_COOLDOWN_AFTER_FAILURE_MS = 5_000;

export type Verification =
  | { kind: 'verified'; repository: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

export type TokenVerifier = (token: string) => Promise<Verification>;

export const fetchGitHubJwks = async (): Promise<unknown> => {
  const response = await fetch(`${ISSUER}/.well-known/jwks`, {
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
  return await response.json();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const importKeys = async (jwks: unknown): Promise<Map<string, CryptoKey>> => {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error('JWKS has no keys');
  const candidates: unknown[] = jwks.keys;
  const imported = await Promise.all(
    candidates.filter(isRecord).map(async jwk => {
      if (typeof jwk.kid !== 'string') return undefined;
      const key = await crypto.subtle
        .importKey('jwk', jwk, RSA, false, ['verify'])
        .catch(() => undefined);
      return key === undefined ? undefined : ([jwk.kid, key] as const);
    }),
  );
  return new Map(imported.filter(entry => entry !== undefined));
};

const parseJwt = (token: string) => {
  const [header, claims, signature, ...rest] = token.split('.');
  if (header === undefined || claims === undefined || signature === undefined) return undefined;
  if (rest.length > 0) return undefined;
  const decodeJson = (part: string): unknown =>
    JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(part, { alphabet: 'base64url' })));
  try {
    const parsed = { header: decodeJson(header), claims: decodeJson(claims) };
    if (!isRecord(parsed.header) || !isRecord(parsed.claims)) return undefined;
    return {
      header: parsed.header,
      claims: parsed.claims,
      signature: Uint8Array.fromBase64(signature, { alphabet: 'base64url' }),
      signed: new TextEncoder().encode(`${header}.${claims}`),
    };
  } catch {
    return undefined;
  }
};

/** Verifies a GitHub Actions OIDC token. `fetchJwks` is a parameter for tests, never for config. */
export const createTokenVerifier = ({
  audience,
  repositoryOwnerId,
  fetchJwks,
  now,
}: {
  audience: string;
  repositoryOwnerId: string;
  fetchJwks: () => Promise<unknown>;
  now: () => Temporal.Instant;
}): TokenVerifier => {
  let keys = new Map<string, CryptoKey>();
  let lastFetch: { atMs: number; isOk: boolean } | undefined;
  let inFlight: Promise<void> | undefined;

  const loadKeys = async () => {
    try {
      keys = await importKeys(await fetchJwks());
      lastFetch = { atMs: now().epochMilliseconds, isOk: true };
    } catch {
      lastFetch = { atMs: now().epochMilliseconds, isOk: false };
    }
  };

  const refreshKeys = () => {
    if (inFlight !== undefined) return inFlight;
    if (lastFetch !== undefined) {
      const cooldown = lastFetch.isOk ? REFETCH_COOLDOWN_MS : REFETCH_COOLDOWN_AFTER_FAILURE_MS;
      if (now().epochMilliseconds - lastFetch.atMs < cooldown) return undefined;
    }
    inFlight = loadKeys().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const findClaimProblem = (claims: Record<string, unknown>): string | undefined => {
    const nowSeconds = now().epochMilliseconds / 1000;
    if (claims.iss !== ISSUER) return 'wrong issuer';
    if (claims.aud !== audience) return 'wrong audience';
    if (typeof claims.exp !== 'number') return 'no expiry';
    if (typeof claims.nbf !== 'number') return 'no not-before';
    if (nowSeconds >= claims.exp + CLOCK_LEEWAY_SECONDS) return 'expired';
    if (nowSeconds < claims.nbf - CLOCK_LEEWAY_SECONDS) return 'not yet valid';
    if (claims.repository_owner_id !== repositoryOwnerId) return 'wrong repository owner';
    if (claims.repository_visibility !== 'private') return 'repository is not private';
    return undefined;
  };

  return async token => {
    const jwt = parseJwt(token);
    if (jwt === undefined) return { kind: 'rejected', reason: 'malformed token' };
    const { header, claims, signature, signed } = jwt;
    if (header.alg !== 'RS256') return { kind: 'rejected', reason: 'algorithm is not RS256' };
    if (typeof header.kid !== 'string') return { kind: 'rejected', reason: 'no key ID' };

    if (!keys.has(header.kid)) await refreshKeys();
    const key = keys.get(header.kid);
    if (key === undefined) {
      return lastFetch?.isOk === false
        ? { kind: 'unavailable', reason: 'could not fetch the JWKS' }
        : { kind: 'rejected', reason: 'unknown key ID' };
    }

    const isSigned = await crypto.subtle.verify(RSA, key, signature, signed).catch(() => false);
    if (!isSigned) return { kind: 'rejected', reason: 'bad signature' };

    const problem = findClaimProblem(claims);
    if (problem !== undefined) return { kind: 'rejected', reason: problem };
    if (typeof claims.repository !== 'string') {
      return { kind: 'rejected', reason: 'no repository claim' };
    }
    return { kind: 'verified', repository: claims.repository };
  };
};
