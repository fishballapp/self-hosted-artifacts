import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
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
import { UploadError, upload } from './upload.ts';

// The runner passes every input as a variable, an unset one as empty.
const input = (name: string) =>
  Config.String(`INPUT_${name.toUpperCase()}`).pipe(
    Config.withDefault(''),
    Config.map(value => value.trim()),
  );

const requiredInput = Effect.fnUntraced(function* (name: string) {
  const value = yield* input(name);
  if (value === '') return yield* new UploadError({ message: `The ${name} input is required` });
  return value;
});

const emptyAsUndefined = (value: string) => (value === '' ? undefined : value);

// A workflow command ends at its line break, so one in the message has to be encoded.
const escapeCommand = (message: string) =>
  message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { name, size, artifactUrl, links, expiresAt } = yield* upload({
    serverUrl: yield* requiredInput('server-url'),
    path: yield* requiredInput('path'),
    name: emptyAsUndefined(yield* input('name')),
    retentionDays: emptyAsUndefined(yield* input('retention-days')),
    audience: emptyAsUndefined(yield* input('audience')) ?? 'self-hosted-artifacts',
  });
  yield* fs.writeFileString(
    yield* Config.String('GITHUB_OUTPUT'),
    [
      `artifact-url=${artifactUrl}`,
      `links=${JSON.stringify(links)}`,
      `expires-at=${expiresAt}\n`,
    ].join('\n'),
    { flag: 'a' },
  );
  yield* Console.log(`Uploaded ${name} (${size} bytes), expires at ${expiresAt}`);
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
      NodePath.layer,
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
