import { isAbsolute } from 'node:path';

const GIB = 1024 ** 3;

export type Config = {
  storeDir: string;
  oidcAudience: string;
  oidcRepositoryOwnerId: string;
  linkBases: Readonly<Record<string, string>>;
  host: string;
  port: number;
  defaultRetentionDays: number;
  maxRetentionDays: number;
  minFreeBytes: number;
  maxFileBytes: number;
};

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`);
  return value;
};

const integer = (
  env: Env,
  name: string,
  { fallback, min, max = Number.MAX_SAFE_INTEGER }: { fallback: number; min: number; max?: number },
): number => {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}, got "${value}"`);
  }
  return parsed;
};

const parseLinkBases = (value: string): Record<string, string> => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(value);
    } catch {
      throw new ConfigError(`LINK_BASES must be JSON, got "${value}"`);
    }
  })();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('LINK_BASES must be a JSON object of label to base URL');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new ConfigError('LINK_BASES must name at least one base URL');
  return Object.fromEntries(
    entries.map(([label, base]: [string, unknown]) => {
      const isHttp =
        typeof base === 'string' && ['http:', 'https:'].includes(URL.parse(base)?.protocol ?? '');
      if (!isHttp) throw new ConfigError(`LINK_BASES.${label} must be an http or https URL`);
      return [label, base.replace(/\/+$/, '')];
    }),
  );
};

export const readConfig = (env: Env): Config => {
  const storeDir = required(env, 'STORE_DIR');
  if (!isAbsolute(storeDir)) throw new ConfigError(`STORE_DIR must be absolute, got "${storeDir}"`);
  const oidcRepositoryOwnerId = required(env, 'OIDC_REPOSITORY_OWNER_ID');
  if (!/^\d+$/.test(oidcRepositoryOwnerId)) {
    throw new ConfigError(
      `OIDC_REPOSITORY_OWNER_ID must be numeric, got "${oidcRepositoryOwnerId}"`,
    );
  }
  return {
    storeDir,
    oidcAudience: required(env, 'OIDC_AUDIENCE'),
    oidcRepositoryOwnerId,
    linkBases: parseLinkBases(required(env, 'LINK_BASES')),
    host: env.HOST === undefined ? '0.0.0.0' : required(env, 'HOST'),
    port: integer(env, 'PORT', { fallback: 8420, min: 0, max: 65535 }),
    defaultRetentionDays: integer(env, 'DEFAULT_RETENTION_DAYS', { fallback: 7, min: 1 }),
    maxRetentionDays: integer(env, 'MAX_RETENTION_DAYS', { fallback: 30, min: 1 }),
    minFreeBytes: integer(env, 'MIN_FREE_BYTES', { fallback: 20 * GIB, min: 0 }),
    maxFileBytes: integer(env, 'MAX_FILE_BYTES', { fallback: 2 * GIB, min: 1 }),
  };
};
