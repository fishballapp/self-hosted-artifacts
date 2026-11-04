import { createHash } from 'node:crypto';
import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import type * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import type * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Predicate from 'effect/Predicate';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { ClientError } from './client-support.ts';
import { codeOf } from './log.ts';
import { ARTIFACT_ID, FILE_NAME, SHA_256 } from './protocol.ts';

// What both targets need of HTTP: the retries, a request that doesn't hold its body in memory, a body
// streamed to a file, and the rules a stored artifact is held to.

const ATTEMPTS = 4;

/** Worth another try: a network error, a 5xx, or a body cut short. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()('UnavailableError', {
  message: Schema.String,
}) {}

// A line break in a value the action writes to its outputs would add an output of the target's
// choosing.
export const SingleLineSchema = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/u));

// Held to the same rules everywhere, as an ID and a name go into a URL and a name into a path here.
export const StoredArtifactFields = {
  id: Schema.String.check(Schema.isPattern(ARTIFACT_ID)),
  name: Schema.String.check(Schema.isPattern(FILE_NAME)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Schema.String.check(Schema.isPattern(SHA_256)),
  expiresAt: SingleLineSchema,
  repositoryId: SingleLineSchema,
  runId: SingleLineSchema,
  runAttempt: SingleLineSchema,
};

export const ListedArtifactSchema = Schema.Struct({
  ...StoredArtifactFields,
  links: Schema.Record(Schema.String, SingleLineSchema),
});
export type ListedArtifact = typeof ListedArtifactSchema.Type;

export const isOk = ({ status }: HttpClientResponse.HttpClientResponse) =>
  status >= 200 && status < 300;

const describeCause = (cause: unknown): string => {
  if (!Predicate.isError(cause)) return String(cause);
  return Predicate.isError(cause.cause)
    ? `${cause.message}: ${cause.cause.message}`
    : cause.message;
};

export const unavailableFrom = ({ reason }: HttpClientError.HttpClientError) =>
  new UnavailableError({
    message: 'cause' in reason ? describeCause(reason.cause) : reason.message,
  });

/**
 * For a request whose URL is a credential. An `HttpClientError`'s message holds the URL, and what a
 * cause says is up to whatever failed, so all that's kept of it is a system error's code.
 */
const unavailableScrubbed =
  (what: string) =>
  ({ reason }: HttpClientError.HttpClientError) => {
    const cause = 'cause' in reason ? reason.cause : undefined;
    const code = codeOf(cause) ?? (Predicate.isError(cause) ? codeOf(cause.cause) : undefined);
    return new UnavailableError({ message: code === undefined ? what : `${what}: ${code}` });
  };

export const unavailableWithoutUrl = unavailableScrubbed('The upload failed');

/** For a download that a redirect may have sent to a URL with a signature in it. */
export const downloadUnavailable = unavailableScrubbed('The download failed');

/**
 * Without both, `fetch` keeps a whole upload's body in memory to replay it on a redirect. A runner
 * has no reason to follow one to anywhere else, so every request with a body refuses them.
 */
const REQUEST_INIT = { redirect: 'error', window: null } as const;

const executeWith =
  (
    init: RequestInit,
    toUnavailable: (error: HttpClientError.HttpClientError) => UnavailableError,
  ) =>
  (client: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(request)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, init),
        Effect.mapError(toUnavailable),
      );

export const executeRequest = executeWith(REQUEST_INIT, unavailableFrom);

/** `executeRequest`, for a URL that must not reach a message. */
export const executeWithoutUrl = executeWith(REQUEST_INIT, unavailableWithoutUrl);

/**
 * The one request that goes where it's sent: a server in front of a bucket answers a link with a
 * redirect. It has no body to hold, and where it ends up holds a signature.
 */
export const executeDownload = executeWith(
  { redirect: 'follow', window: null },
  downloadUnavailable,
);

/** A network error or a 5xx might pass; any other refusal fails at once with its message. */
export const withRetries = <A, R>(
  attempt: Effect.Effect<A, ClientError | UnavailableError, R>,
  note: (message: string) => Effect.Effect<void> = Console.error,
) =>
  attempt.pipe(
    Effect.retry({
      while: Predicate.isTagged('UnavailableError'),
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.while(({ attempt: failed }) => failed < ATTEMPTS),
        // A schedule sees what `while` is about to stop, too, which isn't being retried.
        Schedule.tap(({ attempt: failed, duration, input }) =>
          Predicate.isTagged(input, 'UnavailableError')
            ? note(
                // A line of the target's choosing could otherwise start a workflow command.
                `Attempt ${failed} failed (${input.message.replaceAll(/[\r\n]+/gu, ' ')}), retrying in ${Duration.toSeconds(duration)}s`,
              )
            : Effect.void,
        ),
      ),
    }),
    Effect.catchTag('UnavailableError', ({ message }) => Effect.fail(new ClientError({ message }))),
  );

/** Streams a response to `target`, held to the size it was listed at, and answers with its SHA-256. */
export const streamBodyToFile = Effect.fnUntraced(function* ({
  fs,
  response,
  artifact: { name, size },
  target,
  toUnavailable = unavailableFrom,
}: {
  fs: FileSystem.FileSystem;
  response: HttpClientResponse.HttpClientResponse;
  artifact: ListedArtifact;
  target: string;
  toUnavailable?: (error: HttpClientError.HttpClientError) => UnavailableError;
}) {
  const hash = createHash('sha256');
  let received = 0;
  yield* response.stream.pipe(
    Stream.mapError(toUnavailable),
    Stream.tap(chunk => {
      received += chunk.length;
      if (received > size) {
        return Effect.fail(
          new ClientError({
            message: `${name} is longer than the ${size} bytes it was listed at`,
          }),
        );
      }
      hash.update(chunk);
      return Effect.void;
    }),
    Stream.run(fs.sink(target)),
    Effect.catchTag('PlatformError', () =>
      Effect.fail(new ClientError({ message: `Can't write ${name} to ${target}` })),
    ),
  );
  // Without this a cut body would look like a digest mismatch, which `ignore` would then unzip.
  if (received < size) {
    return yield* new UnavailableError({
      message: `${name} ended after ${received} of its ${size} bytes`,
    });
  }
  return hash.digest('hex');
});
