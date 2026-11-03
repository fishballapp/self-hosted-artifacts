import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Cause from 'effect/Cause';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import { ClientError } from './client-support.ts';

// The runner passes every input as a variable, an unset one as empty.
export const input = (name: string) =>
  Config.String(`INPUT_${name.toUpperCase()}`).pipe(
    Config.withDefault(''),
    Config.map(value => value.trim()),
  );

export const inputOr = (name: string, fallback: string) =>
  input(name).pipe(Config.map(value => (value === '' ? fallback : value)));

export const requiredInput = Effect.fnUntraced(function* (name: string) {
  const value = yield* input(name);
  if (value === '') {
    return yield* new ClientError({ message: `Input required and not supplied: ${name}` });
  }
  return value;
});

// A workflow command ends at its line break, so one in the message has to be encoded.
export const escapeCommand = (message: string) =>
  message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

export const warnInWorkflow = (message: string) =>
  Console.log(`::warning::${escapeCommand(message)}`);

/** Runs an action's body, as the runner expects: a failure is an `::error::` and a failing exit. */
export const runAction = <A, E>(
  main: Effect.Effect<A, E, HttpClient.HttpClient | FileSystem.FileSystem>,
  { failurePrefix = '' }: { failurePrefix?: string } = {},
) =>
  main.pipe(
    Effect.tapCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void;
      const failure = Cause.squash(cause);
      const message = Predicate.isError(failure) ? failure.message : String(failure);
      return Console.log(`::error::${escapeCommand(`${failurePrefix}${message}`)}`);
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
