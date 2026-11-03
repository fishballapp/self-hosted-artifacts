import { createHash } from 'node:crypto';
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
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { ClientError } from './client-support.ts';
import { ARTIFACT_ID, FILE_NAME, SHA_256 } from './protocol.ts';

// Everything that speaks to the artifact server is in this file: the token for each attempt, the
// retries and one function per route. What a target with no server needs would sit beside it.

const ATTEMPTS = 4;
const TOKEN_REQUEST_TIMEOUT = Duration.seconds(30);

class ServerUnavailableError extends Schema.TaggedError<ServerUnavailableError>()(
  'ServerUnavailableError',
  { message: Schema.String },
) {}

// A line break in a value the action writes to its outputs would add an output of the server's
// choosing.
const SingleLineSchema = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/u));

const StoredSchema = Schema.Struct({
  id: SingleLineSchema,
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
});

// Held to the server's own rules, as an ID and a name go into a URL and a name into a path here.
const ListedArtifactSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ARTIFACT_ID)),
  name: Schema.String.check(Schema.isPattern(FILE_NAME)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Schema.String.check(Schema.isPattern(SHA_256)),
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
  repositoryId: SingleLineSchema,
  runId: SingleLineSchema,
  runAttempt: SingleLineSchema,
});
export type ListedArtifact = typeof ListedArtifactSchema.Type;

const ListingSchema = Schema.Struct({ artifacts: Schema.Array(ListedArtifactSchema) });
const RemovedSchema = Schema.Struct({ id: Schema.String, name: Schema.String });

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
    ? new ServerUnavailableError({ message })
    : new ClientError({ message });
});

const describeCause = (cause: unknown): string => {
  if (!Predicate.isError(cause)) return String(cause);
  return Predicate.isError(cause.cause)
    ? `${cause.message}: ${cause.cause.message}`
    : cause.message;
};

const unavailableFrom = ({ reason }: HttpClientError.HttpClientError) =>
  new ServerUnavailableError({
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
          Effect.fail(new ServerUnavailableError({ message: 'The OIDC token request timed out' })),
      }),
    );
  if (!isOk(response)) return yield* yield* readFailure(response);
  const { value } = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenSchema)),
    Effect.mapError(() => new ServerUnavailableError({ message: 'The runner sent no OIDC token' })),
  );
  return Redacted.make(value);
});

const readTokenRequest = Effect.gen(function* () {
  const url = yield* Config.String('ACTIONS_ID_TOKEN_REQUEST_URL').pipe(Config.option);
  const token = yield* Config.Redacted('ACTIONS_ID_TOKEN_REQUEST_TOKEN').pipe(Config.option);
  if (Option.isNone(url) || Option.isNone(token) || url.value === '') {
    return yield* new ClientError({
      message:
        'No OIDC token available: the server only accepts requests from a GitHub Actions job with `permissions: id-token: write`',
    });
  }
  return { url: new URL(url.value), token: token.value };
}).pipe(Effect.catchTag('ConfigError', Effect.die));

export type ServerConnection = {
  readonly base: string;
  readonly tokenRequest: { readonly url: URL; readonly token: Redacted.Redacted };
};

/** Fails at once in a job without `id-token: write`, the likeliest mistake when moving over. */
export const connectToServer = Effect.fnUntraced(function* ({
  serverUrl,
  audience,
}: {
  serverUrl: string;
  audience: string;
}) {
  const tokenRequest = yield* readTokenRequest;
  // The runner's URL already has a query string, so the audience has to join it.
  tokenRequest.url.searchParams.set('audience', audience);
  return { base: serverUrl.replace(/\/+$/u, ''), tokenRequest };
});

/**
 * Without both, `fetch` keeps a whole upload's body in memory to replay it on a redirect. A runner
 * has no reason to follow one to anywhere else, so every request here refuses them.
 */
const REQUEST_INIT = { redirect: 'error', window: null } as const;

const execute = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(request)
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, REQUEST_INIT),
      Effect.mapError(unavailableFrom),
    );
});

/** With a token minted for this attempt alone, as one could expire over a long retry. */
const executeAuthorized = Effect.fnUntraced(function* (
  { tokenRequest }: ServerConnection,
  request: HttpClientRequest.HttpClientRequest,
) {
  const token = yield* mintToken(tokenRequest);
  return yield* execute(HttpClientRequest.bearerToken(request, token));
});

/** A network error or a 5xx might pass; any other refusal fails at once with its message. */
const withRetries = <A, R>(attempt: Effect.Effect<A, ClientError | ServerUnavailableError, R>) =>
  attempt.pipe(
    Effect.retry({
      while: Predicate.isTagged('ServerUnavailableError'),
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.while(({ attempt: failed }) => failed < ATTEMPTS),
        Schedule.tap(({ attempt: failed, duration, input }) =>
          Console.error(
            `Attempt ${failed} failed (${
              // A line of the server's choosing could otherwise start a workflow command.
              Predicate.isTagged(input, 'ServerUnavailableError')
                ? input.message.replaceAll(/[\r\n]+/gu, ' ')
                : 'unknown'
            }), retrying in ${Duration.toSeconds(duration)}s`,
          ),
        ),
      ),
    }),
    Effect.catchTag('ServerUnavailableError', ({ message }) =>
      Effect.fail(new ClientError({ message })),
    ),
  );

/** `POST /artifacts`: stores a file. */
export const sendToServer = Effect.fnUntraced(function* ({
  connection,
  file,
  name,
  digest,
  overwrite,
  retentionDays,
}: {
  connection: ServerConnection;
  file: Blob;
  name: string;
  digest: string;
  overwrite: boolean;
  retentionDays: number;
}) {
  const { base } = connection;
  const attempt = Effect.gen(function* () {
    const response = yield* executeAuthorized(
      connection,
      HttpClientRequest.post(`${base}/artifacts`).pipe(
        HttpClientRequest.setUrlParams({
          name,
          digest,
          ...(overwrite ? { overwrite: 'true' } : {}),
          // The server takes no `0`: leaving it out asks for its default.
          ...(retentionDays === 0 ? {} : { 'retention-days': String(retentionDays) }),
        }),
        HttpClientRequest.setBody(HttpBody.raw(file, { contentType: 'application/octet-stream' })),
      ),
    );
    if (!isOk(response)) return yield* yield* readFailure(response);
    // An answer cut short may follow a stored upload, which a retry recovers by its digest.
    const answer = yield* response.json.pipe(Effect.mapError(unavailableFrom));
    return yield* Schema.decodeUnknownEffect(StoredSchema)(answer).pipe(
      Effect.mapError(() => new ClientError({ message: `${base} answered without a usable link` })),
    );
  });

  const { id, expiresAt, links } = yield* withRetries(attempt);

  const artifactUrl = Object.values(links)[0];
  if (artifactUrl === undefined) {
    return yield* new ClientError({ message: `${base} answered without a usable link` });
  }
  return { id, artifactUrl, links, expiresAt };
});

/** `GET /artifacts`: each name's latest in a run. The token's repository and run are the default. */
export const listOnServer = Effect.fnUntraced(function* ({
  connection,
  repository,
  runId,
  names = [],
  ids = [],
}: {
  connection: ServerConnection;
  repository: string;
  runId: string;
  names?: readonly string[];
  ids?: readonly string[];
}) {
  const { base } = connection;
  const { artifacts } = yield* withRetries(
    Effect.gen(function* () {
      const response = yield* executeAuthorized(
        connection,
        HttpClientRequest.get(`${base}/artifacts`).pipe(
          HttpClientRequest.setUrlParams({
            ...(repository === '' ? {} : { repository }),
            ...(runId === '' ? {} : { 'run-id': runId }),
            name: names,
            id: ids,
          }),
        ),
      );
      if (!isOk(response)) return yield* yield* readFailure(response);
      const answer = yield* response.json.pipe(Effect.mapError(unavailableFrom));
      return yield* Schema.decodeUnknownEffect(ListingSchema)(answer).pipe(
        Effect.mapError(
          () => new ClientError({ message: `${base} answered with an unusable artifact list` }),
        ),
      );
    }),
  );
  return artifacts;
});

/**
 * `GET /<id>/<name>`: streams a file to `target`, and answers with the SHA-256 of what came. From
 * `base`, not a link: a link's base is what people use, which a runner may not reach.
 */
export const fetchFromServer = Effect.fnUntraced(function* ({
  connection: { base },
  artifact: { id, name, size },
  target,
}: {
  connection: ServerConnection;
  artifact: ListedArtifact;
  target: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* withRetries(
    Effect.gen(function* () {
      const response = yield* execute(HttpClientRequest.get(`${base}/${id}/${name}`));
      if (!isOk(response)) return yield* yield* readFailure(response);
      const hash = createHash('sha256');
      let received = 0;
      yield* response.stream.pipe(
        Stream.mapError(unavailableFrom),
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
        return yield* new ServerUnavailableError({
          message: `${name} ended after ${received} of its ${size} bytes`,
        });
      }
      return hash.digest('hex');
    }),
  );
});

/** `DELETE /artifacts/<id>`, in the token's own repository. */
export const deleteOnServer = Effect.fnUntraced(function* ({
  connection,
  id,
}: {
  connection: ServerConnection;
  id: string;
}) {
  const { base } = connection;
  return yield* withRetries(
    Effect.gen(function* () {
      const response = yield* executeAuthorized(
        connection,
        HttpClientRequest.delete(`${base}/artifacts/${id}`),
      );
      if (!isOk(response)) return yield* yield* readFailure(response);
      const answer = yield* response.json.pipe(Effect.mapError(unavailableFrom));
      return yield* Schema.decodeUnknownEffect(RemovedSchema)(answer).pipe(
        Effect.mapError(
          () => new ClientError({ message: `${base} answered with an unusable deletion` }),
        ),
      );
    }),
  );
});
