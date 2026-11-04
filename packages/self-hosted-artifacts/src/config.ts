import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { describeError } from './log.ts';
import { isHttpBase, S3_BUCKET, S3_REGION } from './protocol.ts';

const GIB = 1024 ** 3;
const MAX_GIB = Number.MAX_SAFE_INTEGER / GIB;

// No query or fragment: a link is this base with `/<token>/<name>` after it.
const isLinkBase = (base: string) =>
  /^https?:\/\/[^\s?#]+$/iu.test(base) && URL.parse(base) !== null;

const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const DiskStoreFileSchema = Schema.Struct({
  kind: Schema.Literal('disk'),
  dir: Schema.String.check(Schema.isPattern(/^\//u)),
  minFreeGiB: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_GIB })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
  ),
});

const S3StoreFileSchema = Schema.Struct({
  kind: Schema.Literal('s3'),
  bucket: Schema.String.check(Schema.isPattern(S3_BUCKET)),
  region: Schema.String.check(Schema.isPattern(S3_REGION)),
  endpoint: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter(isHttpBase, { message: 'an http(s) base URL' })),
  ),
});

const ConfigFileSchema = Schema.Struct({
  store: Schema.Union([DiskStoreFileSchema, S3StoreFileSchema]),
  oidcAudience: Schema.NonEmptyString,
  oidcRepositoryOwnerId: positiveInt,
  linkBases: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.makeFilter(isLinkBase, { message: 'an http(s) base URL' })),
  ).check(Schema.isMinProperties(1)),
  host: Schema.NonEmptyString.pipe(Schema.withDecodingDefaultKey(Effect.succeed('0.0.0.0'))),
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8420)),
  ),
  defaultRetentionDays: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(90))),
  maxRetentionDays: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(90))),
  maxFileGiB: Schema.Finite.check(Schema.isBetween({ minimum: 1 / GIB, maximum: MAX_GIB })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
});

export type DiskStoreConfig = {
  readonly kind: 'disk';
  readonly dir: string;
  readonly minFreeBytes: number;
};

export type S3StoreConfig = {
  readonly kind: 's3';
  readonly bucket: string;
  readonly region: string;
  /** Empty on AWS. */
  readonly endpoint: string;
};

export type Config = {
  readonly store: DiskStoreConfig | S3StoreConfig;
  readonly oidcAudience: string;
  readonly oidcRepositoryOwnerId: string;
  readonly linkBases: Readonly<Record<string, string>>;
  readonly host: string;
  readonly port: number;
  readonly defaultRetentionDays: number;
  readonly maxRetentionDays: number;
  readonly maxFileBytes: number;
};

const toStoreConfig = (store: typeof ConfigFileSchema.Type.store): Config['store'] => {
  if (store.kind === 's3') return { ...store, endpoint: store.endpoint ?? '' };
  const { minFreeGiB, ...disk } = store;
  return { ...disk, minFreeBytes: Math.floor(minFreeGiB * GIB) };
};

const toConfig = ({
  store,
  oidcRepositoryOwnerId,
  linkBases,
  maxFileGiB,
  ...settings
}: typeof ConfigFileSchema.Type): Config => ({
  ...settings,
  store: toStoreConfig(store),
  // GitHub's token carries the ID as a string.
  oidcRepositoryOwnerId: String(oidcRepositoryOwnerId),
  linkBases: Object.fromEntries(
    Object.entries(linkBases).map(([label, base]) => [label, base.replace(/\/+$/u, '')]),
  ),
  maxFileBytes: Math.floor(maxFileGiB * GIB),
});

export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  message: Schema.String,
}) {}

/** `onExcessProperty`, so a misspelt setting stops the server rather than being a silent default. */
export const parseConfig = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(ConfigFileSchema))(text, {
    onExcessProperty: 'error',
  }).pipe(Effect.map(toConfig));

export const readConfigFile = Effect.fn('config.readConfigFile')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      error =>
        new ConfigError({
          message: `Can't read the config file ${path}: ${describeError(error)}`,
        }),
    ),
  );
  return yield* parseConfig(text).pipe(
    Effect.mapError(
      error => new ConfigError({ message: `The config file ${path} is invalid: ${error.message}` }),
    ),
  );
});

export class ServerConfig extends Context.Service<ServerConfig, Config>()(
  'self-hosted-artifacts/ServerConfig',
) {
  static readonly layerFromFile = (path: string) =>
    Layer.effect(ServerConfig, readConfigFile(path));
}
