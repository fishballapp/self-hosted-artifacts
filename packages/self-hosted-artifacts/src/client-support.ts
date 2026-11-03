import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Schema from 'effect/Schema';

/** Why a client command didn't do what it was asked, after any retries. */
export class ClientError extends Schema.TaggedError<ClientError>()('ClientError', {
  message: Schema.String,
}) {}

/** The same in the actions' inputs and the commands' flags. */
export const DEFAULT_AUDIENCE = 'self-hosted-artifacts';

const BooleanInputSchema = Schema.Literals(['true', 'True', 'TRUE', 'false', 'False', 'FALSE']);

export const parseBooleanInput = Effect.fnUntraced(function* (name: string, value: string) {
  if (!Schema.is(BooleanInputSchema)(value)) {
    return yield* new ClientError({
      message: `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\nSupport boolean input list: \`true | True | TRUE | false | False | FALSE\``,
    });
  }
  return value.toLowerCase() === 'true';
});

const runnerTemp = Config.String('RUNNER_TEMP').pipe(
  Config.withDefault(undefined),
  Effect.catchTag('ConfigError', Effect.die),
);

/** A temp file in `RUNNER_TEMP`, removed with the surrounding scope however the step ends. */
export const makeRunnerTempFile = Effect.fnUntraced(function* (suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* runnerTemp;
  return yield* fs.makeTempFileScoped({ directory, prefix: 'self-hosted-artifacts-', suffix }).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          message: `Can't create a temporary file in ${directory ?? 'the system temp folder'}`,
        }),
    ),
  );
});

/** A temp folder in `RUNNER_TEMP`, removed with what's in it as the surrounding scope ends. */
export const makeRunnerTempDirectory = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* runnerTemp;
  return yield* fs.makeTempDirectoryScoped({ directory, prefix: 'self-hosted-artifacts-' }).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          message: `Can't create a temporary folder in ${directory ?? 'the system temp folder'}`,
        }),
    ),
  );
});
