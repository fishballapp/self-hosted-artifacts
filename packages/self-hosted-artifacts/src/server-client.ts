import * as Config from 'effect/Config';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { ClientError } from './client-support.ts';
import type { Target } from './target.ts';
import {
  executeRequest,
  isOk,
  ListedArtifactSchema,
  SingleLineSchema,
  streamBodyToFile,
  UnavailableError,
  unavailableFrom,
  withRetries,
} from './transport.ts';

// The target with a server: the token for each attempt, and one method per route.

const TOKEN_REQUEST_TIMEOUT = Duration.seconds(30);

const StoredSchema = Schema.Struct({
  id: SingleLineSchema,
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
});

const ListingSchema = Schema.Struct({ artifacts: Schema.Array(ListedArtifactSchema) });
const RemovedSchema = Schema.Struct({ id: Schema.String, name: Schema.String });

const FailureSchema = Schema.Struct({ error: Schema.String });
const TokenSchema = Schema.Struct({ value: Schema.String });

const readFailure = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const message = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FailureSchema)),
    Effect.map(({ error }) => error),
    Effect.orElseSucceed(() => `HTTP ${response.status}`),
  );
  return response.status >= 500 ? new UnavailableError({ message }) : new ClientError({ message });
});

const mintToken = Effect.fnUntraced(function* ({
  client,
  url,
  token,
}: {
  client: HttpClient.HttpClient;
  url: URL;
  token: Redacted.Redacted;
}) {
  const response = yield* client
    .get(url, {
      headers: { Authorization: `Bearer ${Redacted.value(token)}`, Accept: 'application/json' },
    })
    .pipe(
      Effect.mapError(unavailableFrom),
      Effect.timeoutOrElse({
        duration: TOKEN_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new UnavailableError({ message: 'The OIDC token request timed out' })),
      }),
    );
  if (!isOk(response)) return yield* yield* readFailure(response);
  const { value } = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenSchema)),
    Effect.mapError(() => new UnavailableError({ message: 'The runner sent no OIDC token' })),
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

export const makeServerTarget = Effect.fnUntraced(function* ({
  serverUrl,
  audience,
}: {
  serverUrl: string;
  audience: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const base = serverUrl.replace(/\/+$/u, '');

  const readAudiencedTokenRequest = Effect.map(readTokenRequest, tokenRequest => {
    // The runner's URL already has a query string, so the audience has to join it.
    tokenRequest.url.searchParams.set('audience', audience);
    return tokenRequest;
  });

  /** With a token minted for this attempt alone, as one could expire over a long retry. */
  const executeAuthorized = Effect.fnUntraced(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* mintToken({ client, ...(yield* readAudiencedTokenRequest) });
    return yield* executeRequest(client, HttpClientRequest.bearerToken(request, token));
  });

  return {
    // Fails at once in a job without `id-token: write`, the likeliest mistake when moving over.
    ready: Effect.asVoid(readAudiencedTokenRequest),

    /** `POST /artifacts`. */
    send: Effect.fnUntraced(function* ({ file, name, digest, overwrite, retentionDays }) {
      const attempt = Effect.gen(function* () {
        const response = yield* executeAuthorized(
          HttpClientRequest.post(`${base}/artifacts`).pipe(
            HttpClientRequest.setUrlParams({
              name,
              digest,
              ...(overwrite ? { overwrite: 'true' } : {}),
              // The server takes no `0`: leaving it out asks for its default.
              ...(retentionDays === 0 ? {} : { 'retention-days': String(retentionDays) }),
            }),
            HttpClientRequest.setBody(
              HttpBody.raw(file, { contentType: 'application/octet-stream' }),
            ),
          ),
        );
        if (!isOk(response)) return yield* yield* readFailure(response);
        // An answer cut short may follow a stored upload, which a retry recovers by its digest.
        const answer = yield* response.json.pipe(Effect.mapError(unavailableFrom));
        return yield* Schema.decodeUnknownEffect(StoredSchema)(answer).pipe(
          Effect.mapError(
            () => new ClientError({ message: `${base} answered without a usable link` }),
          ),
        );
      });

      const { id, expiresAt, links } = yield* withRetries(attempt);

      const artifactUrl = Object.values(links)[0];
      if (artifactUrl === undefined) {
        return yield* new ClientError({ message: `${base} answered without a usable link` });
      }
      return { id, artifactUrl, links, expiresAt };
    }),

    /** `GET /artifacts`. The token's repository and run are the default. */
    list: Effect.fnUntraced(function* ({ repository, runId, names = [], ids = [] }) {
      const { artifacts } = yield* withRetries(
        Effect.gen(function* () {
          const response = yield* executeAuthorized(
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
    }),

    /** `GET /<id>/<name>`. From `base`, not a link: a runner may not reach a link's base. */
    fetch: ({ artifact, target }) =>
      withRetries(
        Effect.gen(function* () {
          const response = yield* executeRequest(
            client,
            HttpClientRequest.get(`${base}/${artifact.id}/${artifact.name}`),
          );
          if (!isOk(response)) return yield* yield* readFailure(response);
          return yield* streamBodyToFile({ fs, response, artifact, target });
        }),
      ),

    /** `DELETE /artifacts/<id>`, in the token's own repository. */
    remove: id =>
      withRetries(
        Effect.gen(function* () {
          const response = yield* executeAuthorized(
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
      ),
  } satisfies Target;
});
