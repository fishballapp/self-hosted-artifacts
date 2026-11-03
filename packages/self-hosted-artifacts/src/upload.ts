import { openAsBlob } from 'node:fs';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';

const ATTEMPTS = 4;
const TOKEN_REQUEST_TIMEOUT = Duration.seconds(30);

/** Why the upload didn't happen, after any retries. */
export class UploadError extends Schema.TaggedError<UploadError>()('UploadError', {
  message: Schema.String,
}) {}

class UploadUnavailableError extends Schema.TaggedError<UploadUnavailableError>()(
  'UploadUnavailableError',
  {
    message: Schema.String,
  },
) {}

// A line break in a value the action writes to its outputs would add an output of the server's
// choosing.
const SingleLineSchema = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/u));

const StoredSchema = Schema.Struct({
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
});

const FailureSchema = Schema.Struct({ error: Schema.String });
const TokenSchema = Schema.Struct({ value: Schema.String });

const isOk = ({ status }: HttpClientResponse.HttpClientResponse) => status >= 200 && status < 300;

const readFailure = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const message = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FailureSchema)),
    Effect.map(({ error }) => error),
    Effect.orElseSucceed(() => `HTTP ${response.status}`),
  );
  return response.status >= 500
    ? new UploadUnavailableError({ message })
    : new UploadError({ message });
});

const describeCause = (cause: unknown): string => {
  if (!Predicate.isError(cause)) return String(cause);
  return Predicate.isError(cause.cause)
    ? `${cause.message}: ${cause.cause.message}`
    : cause.message;
};

const unavailableFrom = ({ reason }: HttpClientError.HttpClientError) =>
  new UploadUnavailableError({
    message: 'cause' in reason ? describeCause(reason.cause) : reason.message,
  });

const mintToken = Effect.fnUntraced(function* ({
  url,
  token,
}: {
  url: URL;
  token: Redacted.Redacted;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(url, {
      headers: { Authorization: `Bearer ${Redacted.value(token)}`, Accept: 'application/json' },
    })
    .pipe(
      Effect.mapError(unavailableFrom),
      Effect.timeoutOrElse({
        duration: TOKEN_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new UploadUnavailableError({ message: 'The OIDC token request timed out' })),
      }),
    );
  if (!isOk(response)) return yield* yield* readFailure(response);
  const { value } = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenSchema)),
    Effect.mapError(() => new UploadUnavailableError({ message: 'The runner sent no OIDC token' })),
  );
  return Redacted.make(value);
});

const readTokenRequest = Effect.gen(function* () {
  const url = yield* Config.String('ACTIONS_ID_TOKEN_REQUEST_URL').pipe(Config.option);
  const token = yield* Config.Redacted('ACTIONS_ID_TOKEN_REQUEST_TOKEN').pipe(Config.option);
  if (Option.isNone(url) || Option.isNone(token) || url.value === '') {
    return yield* new UploadError({
      message:
        'No OIDC token available: the server only accepts uploads from a GitHub Actions job with `permissions: id-token: write`',
    });
  }
  return { url: new URL(url.value), token: token.value };
}).pipe(Effect.catchTag('ConfigError', Effect.die));

const openFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(path)
    .pipe(Effect.mapError(() => new UploadError({ message: `No file at ${path}` })));
  if (info.type === 'Directory') {
    return yield* new UploadError({
      message: `${path} is a folder; folders are not supported yet. Upload one file`,
    });
  }
  return yield* Effect.tryPromise({
    try: () => openAsBlob(path),
    catch: () => new UploadError({ message: `Can't read ${path}` }),
  });
});

/** Without both, `fetch` keeps the whole body in memory to replay it on a redirect. */
const STREAMING_REQUEST_INIT = { redirect: 'error', window: null } as const;

export const upload = Effect.fn('upload.upload')(function* ({
  serverUrl,
  path,
  name: givenName,
  retentionDays,
  audience,
}: {
  serverUrl: string;
  path: string;
  name: string | undefined;
  retentionDays: string | undefined;
  audience: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const { basename } = yield* Path.Path;
  const name = givenName ?? basename(path);
  const file = yield* openFile(path);
  const tokenRequest = yield* readTokenRequest;
  // The runner's URL already has a query string, so the audience has to join it.
  tokenRequest.url.searchParams.set('audience', audience);
  const base = serverUrl.replace(/\/+$/u, '');

  const attempt = Effect.gen(function* () {
    const token = yield* mintToken(tokenRequest);
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${base}/artifacts`).pipe(
          HttpClientRequest.setUrlParams({
            name,
            ...(retentionDays === undefined ? {} : { 'retention-days': retentionDays }),
          }),
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setBody(
            HttpBody.raw(file, { contentType: 'application/octet-stream' }),
          ),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, STREAMING_REQUEST_INIT),
        Effect.mapError(unavailableFrom),
      );
    if (!isOk(response)) return yield* yield* readFailure(response);
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StoredSchema)),
      Effect.mapError(() => new UploadError({ message: `${base} answered without a usable link` })),
    );
  });

  const { expiresAt, links } = yield* attempt.pipe(
    Effect.retry({
      while: Predicate.isTagged('UploadUnavailableError'),
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.while(({ attempt: failed }) => failed < ATTEMPTS),
        Schedule.tap(({ attempt: failed, duration, input }) =>
          Console.error(
            `Attempt ${failed} failed (${
              // A line of the server's choosing could otherwise start a workflow command.
              Predicate.isTagged(input, 'UploadUnavailableError')
                ? input.message.replaceAll(/[\r\n]+/gu, ' ')
                : 'unknown'
            }), retrying in ${Duration.toSeconds(duration)}s`,
          ),
        ),
      ),
    }),
    Effect.catchTag('UploadUnavailableError', ({ message }) =>
      Effect.fail(new UploadError({ message })),
    ),
  );

  const artifactUrl = Object.values(links)[0];
  if (artifactUrl === undefined) {
    return yield* new UploadError({ message: `${base} answered without a usable link` });
  }
  return { name, size: file.size, artifactUrl, links, expiresAt };
});
