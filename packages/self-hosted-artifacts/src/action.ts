import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Cause from 'effect/Cause';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import { UPLOAD_DEFAULTS, UploadError, upload } from './upload.ts';

// The runner passes every input as a variable, an unset one as empty.
const input = (name: string) =>
  Config.String(`INPUT_${name.toUpperCase()}`).pipe(
    Config.withDefault(''),
    Config.map(value => value.trim()),
  );

const inputOr = (name: string, fallback: string) =>
  input(name).pipe(Config.map(value => (value === '' ? fallback : value)));

const requiredInput = Effect.fnUntraced(function* (name: string) {
  const value = yield* input(name);
  if (value === '') {
    return yield* new UploadError({ message: `Input required and not supplied: ${name}` });
  }
  return value;
});

// A workflow command ends at its line break, so one in the message has to be encoded.
const escapeCommand = (message: string) =>
  message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* upload({
    serverUrl: yield* requiredInput('server-url'),
    path: yield* requiredInput('path'),
    name: yield* inputOr('name', UPLOAD_DEFAULTS.name),
    ifNoFilesFound: yield* inputOr('if-no-files-found', UPLOAD_DEFAULTS.ifNoFilesFound),
    retentionDays: yield* inputOr('retention-days', UPLOAD_DEFAULTS.retentionDays),
    compressionLevel: yield* inputOr('compression-level', UPLOAD_DEFAULTS.compressionLevel),
    includeHiddenFiles: yield* inputOr('include-hidden-files', UPLOAD_DEFAULTS.includeHiddenFiles),
    archive: yield* inputOr('archive', UPLOAD_DEFAULTS.archive),
    overwrite: yield* inputOr('overwrite', UPLOAD_DEFAULTS.overwrite),
    audience: yield* inputOr('audience', UPLOAD_DEFAULTS.audience),
  });
  if (result._tag === 'NoFilesFound') {
    return yield* Console.log(
      result.isWarning ? `::warning::${escapeCommand(result.message)}` : result.message,
    );
  }
  const { id, name, size, digest, artifactUrl, links, expiresAt } = result;
  yield* fs.writeFileString(
    yield* Config.String('GITHUB_OUTPUT'),
    [
      `artifact-id=${id}`,
      `artifact-url=${artifactUrl}`,
      `artifact-digest=${digest}`,
      `links=${JSON.stringify(links)}`,
      `expires-at=${expiresAt}\n`,
    ].join('\n'),
    { flag: 'a' },
  );
  return yield* Console.log(`Uploaded ${name} (${size} bytes), expires at ${expiresAt}`);
});

main.pipe(
  Effect.tapCause(cause => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const failure = Cause.squash(cause);
    return Console.log(
      `::error::${escapeCommand(Predicate.isError(failure) ? failure.message : String(failure))}`,
    );
  }),
  Effect.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      // No trace headers on requests to the runner or the server: neither has a use for them.
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
      NodeFileSystem.layer,
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
