import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { describeError } from './log.ts';

const GIB = 1024 ** 3;
const MAX_GIB = Number.MAX_SAFE_INTEGER / GIB;

// No query or fragment: a link is this base with `/<token>/<name>` after it.
const isLinkBase = (base: string) =>
  /^https?:\/\/[^\s?#]+$/iu.test(base) && URL.parse(base) !== null;

const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const ConfigFileSchema = Schema.Struct({
  storeDir: Schema.String.check(Schema.isPattern(/^\//u)),
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
  defaultRetentionDays: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))),
  maxRetentionDays: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(30))),
  minFreeGiB: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_GIB })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
  ),
  maxFileGiB: Schema.Finite.check(Schema.isBetween({ minimum: 1 / GIB, maximum: MAX_GIB })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
});

export type Config = {
  readonly storeDir: string;
  readonly oidcAudience: string;
  readonly oidcRepositoryOwnerId: string;
  readonly linkBases: Readonly<Record<string, string>>;
  readonly host: string;
  readonly port: number;
  readonly defaultRetentionDays: number;
  readonly maxRetentionDays: number;
  readonly minFreeBytes: number;
  readonly maxFileBytes: number;
};

const toConfig = ({
  oidcRepositoryOwnerId,
  linkBases,
  minFreeGiB,
  maxFileGiB,
  ...settings
}: typeof ConfigFileSchema.Type): Config => ({
  ...settings,
  // GitHub's token carries the ID as a string.
  oidcRepositoryOwnerId: String(oidcRepositoryOwnerId),
  linkBases: Object.fromEntries(
    Object.entries(linkBases).map(([label, base]) => [label, base.replace(/\/+$/u, '')]),
  ),
  minFreeBytes: Math.floor(minFreeGiB * GIB),
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
