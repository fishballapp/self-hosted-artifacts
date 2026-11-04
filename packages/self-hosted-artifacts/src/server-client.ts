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
import { uriEncode } from './protocol.ts';
import type { Target } from './target.ts';
import {
  downloadUnavailable,
  executeDownload,
  executeRequest,
  executeWithoutUrl,
  isOk,
  ListedArtifactSchema,
  SingleLineSchema,
  StoredArtifactFields,
  streamBodyToFile,
  UnavailableError,
  unavailableFrom,
  unavailableWithoutUrl,
  withRetries,
} from './transport.ts';

// The target with a server: the token for each attempt, and one method per route.

const TOKEN_REQUEST_TIMEOUT = Duration.seconds(30);

const StoredSchema = Schema.Struct({
  id: SingleLineSchema,
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
});

const UploadTargetSchema = Schema.Struct({
  upload: Schema.Struct({
    id: StoredArtifactFields.id,
    url: SingleLineSchema,
    headers: Schema.Record(Schema.String, SingleLineSchema),
  }),
});

const ListingSchema = Schema.Struct({ artifacts: Schema.Array(ListedArtifactSchema) });
const RemovedSchema = Schema.Struct({ id: Schema.String, name: Schema.String });

const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
);
const TokenSchema = Schema.Struct({ value: Schema.String });

/**
 * A bucket answers a body it refuses in XML. Only its code: the rest can hold the string it signed and
 * the access key's ID.
 */
const readFailure = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
  const bucketCode = /<Code>([A-Za-z]+)<\/Code>/u.exec(body)?.[1];
  const message = Option.match(decodeFailure(body), {
    onSome: ({ error }) => error,
    onNone: () =>
      bucketCode === undefined
        ? `HTTP ${response.status}`
        : `HTTP ${response.status}: ${bucketCode}`,
  });
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
    execute: typeof executeRequest = executeRequest,
  ) {
    const token = yield* mintToken({ client, ...(yield* readAudiencedTokenRequest) });
    return yield* execute(client, HttpClientRequest.bearerToken(request, token));
  });

  const decodeStored = (answer: unknown) =>
    Schema.decodeUnknownEffect(StoredSchema)(answer).pipe(
      Effect.mapError(() => new ClientError({ message: `${base} answered without a usable link` })),
    );

  return {
    // Fails at once in a job without `id-token: write`, the likeliest mistake when moving over.
    ready: Effect.asVoid(readAudiencedTokenRequest),

    /**
     * `POST /uploads`, `PUT` of the body and `POST /uploads/<id>/commit`, each attempt all three. A
     * commit whose answer was lost is recovered by the next attempt's first step: the digest is stored.
     */
    send: Effect.fnUntraced(function* ({ file, name, digest, overwrite, retentionDays }) {
      const declaration = {
        name,
        digest,
        size: String(file.size),
        ...(overwrite ? { overwrite: 'true' } : {}),
        // The server takes no `0`: leaving it out asks for its default.
        ...(retentionDays === 0 ? {} : { 'retention-days': String(retentionDays) }),
      };

      const attempt = Effect.gen(function* () {
        const created = yield* executeAuthorized(
          HttpClientRequest.post(`${base}/uploads`).pipe(
            HttpClientRequest.setUrlParams(declaration),
          ),
        );
        if (!isOk(created)) return yield* yield* readFailure(created);
        const answer = yield* created.json.pipe(Effect.mapError(unavailableFrom));
        if (created.status === 200) return yield* decodeStored(answer);

        const {
          upload: { id, url, headers },
        } = yield* Schema.decodeUnknownEffect(UploadTargetSchema)(answer).pipe(
          Effect.mapError(
            () => new ClientError({ message: `${base} answered without a usable upload` }),
          ),
        );
        // Against `server-url`, as a runner reaches the server by that, keeping any path it has.
        const target = URL.parse(url.replace(/^\/+/u, ''), `${base}/`);
        if (target === null) {
          return yield* new ClientError({ message: `${base} answered without a usable upload` });
        }
        const addressed = HttpClientRequest.put(target.href).pipe(
          HttpClientRequest.setHeaders(headers),
        );
        const sent = yield* executeWithoutUrl(
          client,
          // `setBody` sets the body's own `Content-Type` over the one given, and what's given may be signed.
          HttpClientRequest.setBody(
            addressed,
            HttpBody.raw(file, { contentType: addressed.headers['content-type'] }),
          ),
        );
        if (!isOk(sent)) return yield* yield* readFailure(sent);

        const committed = yield* executeAuthorized(
          HttpClientRequest.post(`${base}/uploads/${id}/commit`).pipe(
            HttpClientRequest.setUrlParams(declaration),
          ),
          executeWithoutUrl,
        );
        if (!isOk(committed)) return yield* yield* readFailure(committed);
        return yield* decodeStored(
          yield* committed.json.pipe(Effect.mapError(unavailableWithoutUrl)),
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

    /**
     * `GET /<id>/<name>`. From `base`, not a link: a runner may not reach a link's base. A server in
     * front of a bucket redirects this, and each retry asks it for a new URL.
     */
    fetch: ({ artifact, target }) =>
      withRetries(
        Effect.gen(function* () {
          const response = yield* executeDownload(
            client,
            HttpClientRequest.get(`${base}/${artifact.id}/${uriEncode(artifact.name)}`, {
              // `fetch` asks for gzip by default, and R2 would then compress what the digest is of.
              headers: { 'accept-encoding': 'identity' },
            }),
          );
          if (!isOk(response)) return yield* yield* readFailure(response);
          return yield* streamBodyToFile({
            fs,
            response,
            artifact,
            target,
            toUnavailable: downloadUnavailable,
          });
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
