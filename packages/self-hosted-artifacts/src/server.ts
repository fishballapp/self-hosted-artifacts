import { createServer, type Server } from 'node:http';
import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HttpRouter from 'effect/http/HttpRouter';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { type Config, ServerConfig } from './config.ts';
import { describeError, shortToken } from './log.ts';
import { TokenVerifier } from './oidc.ts';
import {
  ARTIFACT_ID,
  BAD_RETENTION,
  FILE_NAME,
  FILE_NAME_MESSAGE,
  NAME_TAKEN,
  OTHER_REPOSITORY,
  REPOSITORY,
  RUN_ID,
  SHA_256,
} from './protocol.ts';
import { type ArtifactMeta, Store, UPLOAD_TIMEOUT, UploadFailedError } from './store.ts';

const ARTIFACTS_URL = /^\/artifacts(?:\?(.*))?$/;
const ARTIFACT_URL = /^\/artifacts\/([A-Za-z0-9_-]{43})$/;
const DOWNLOAD_URL = /^\/([A-Za-z0-9_-]{43})\/([^/?#]+)$/;
const UNREAD_BODY_GRACE = Duration.seconds(5);
// A client that stops reading or sending gets cut off, so a stalled download can't keep an expired
// file's blocks on disk after its sweep. Long enough for a phone to return from the background. With
// a write pending, Node restarts this timer, so a stalled download goes at two or three times this.
const IDLE_TIMEOUT = Duration.minutes(5);

const respondJson = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status });

const notFound = respondJson(404, { error: 'Not found' });

/** A request turned away. `message` is the client's, `reason` the log's, and may say more. */
class RequestRefusedError extends Schema.TaggedError<RequestRefusedError>()('RequestRefusedError', {
  status: Schema.Finite,
  message: Schema.String,
  reason: Schema.String,
}) {}

const refusal = (status: number, message: string, reason = message) =>
  new RequestRefusedError({ status, message, reason });

const parseRetentionDays = (
  value: string | null,
  { defaultRetentionDays, maxRetentionDays }: Config,
): number | undefined => {
  if (value === null) return Math.min(defaultRetentionDays, maxRetentionDays);
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Math.min(Number(value), maxRetentionDays);
};

/** The Node server under the routes, with the timeouts `NodeHttpServer` has no option for. */
export const makeNodeServer = (idleTimeoutMs = Duration.toMillis(IDLE_TIMEOUT)): Server => {
  const server = createServer();
  server.requestTimeout = Duration.toMillis(UPLOAD_TIMEOUT);
  server.timeout = idleTimeoutMs;
  return server;
};

export const ArtifactRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const verifier = yield* TokenVerifier;
    const scope = yield* Effect.scope;

    /**
     * Answers an upload whose body is still unread. Node discards what arrives next, so the
     * connection stays open long enough for the client to read the answer: closing on unread bytes
     * can reset the connection and lose it. A client still sending after the grace period gets cut
     * off.
     */
    const answerUnread = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
      status: number,
      body: unknown,
    ) {
      const source = NodeHttpServerRequest.toIncomingMessage(request);
      yield* Effect.sleep(UNREAD_BODY_GRACE).pipe(
        Effect.andThen(Effect.sync(() => source.destroy())),
        Effect.forkIn(scope),
      );
      return respondJson(status, body);
    });

    const refuseAndLog = (
      request: HttpServerRequest.HttpServerRequest,
      status: number,
      message: string,
      reason = message,
    ) =>
      Effect.logInfo('upload refused').pipe(
        Effect.annotateLogs({ status, reason }),
        Effect.andThen(answerUnread(request, status, { error: message })),
      );

    /** Every route but a download starts here, and only the claims it answers with decide scope. */
    const authenticate = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (token === undefined) {
        return yield* refusal(401, 'Token rejected', 'no bearer token');
      }
      return yield* verifier
        .verify(token)
        .pipe(
          Effect.mapError(failure =>
            failure._tag === 'SigningKeysUnavailableError'
              ? refusal(503, 'GitHub signing keys are unavailable', failure.reason)
              : refusal(401, 'Token rejected', failure.reason),
          ),
        );
    });

    const answeringRefusals =
      (action: string) =>
      <A, R>(self: Effect.Effect<A, RequestRefusedError, R>) =>
        self.pipe(
          Effect.catchTag('RequestRefusedError', ({ status, message, reason }) =>
            Effect.logInfo(`${action} refused`).pipe(
              Effect.annotateLogs({ status, reason }),
              Effect.as(respondJson(status, { error: message })),
            ),
          ),
        );

    const describeArtifact = ({ id, name, size, digest, expiresAt }: ArtifactMeta) => ({
      id,
      name,
      size,
      digest,
      expiresAt: expiresAt.toString(),
      links: Object.fromEntries(
        Object.entries(config.linkBases).map(([label, base]) => [label, `${base}/${id}/${name}`]),
      ),
    });

    const upload = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const uploadMatch = ARTIFACTS_URL.exec(request.url);
      if (uploadMatch === null) return notFound;

      const verification = yield* authenticate(request).pipe(Effect.result);
      if (verification._tag === 'Failure') {
        const { status, message, reason } = verification.failure;
        return yield* refuseAndLog(request, status, message, reason);
      }

      const params = new URLSearchParams(uploadMatch[1] ?? '');
      const name = params.get('name');
      if (name === null || !FILE_NAME.test(name)) {
        return yield* refuseAndLog(request, 400, FILE_NAME_MESSAGE);
      }
      const retentionDays = parseRetentionDays(params.get('retention-days'), config);
      if (retentionDays === undefined) {
        return yield* refuseAndLog(request, 400, BAD_RETENTION);
      }
      const digest = params.get('digest') ?? undefined;
      if (digest !== undefined && !SHA_256.test(digest)) {
        return yield* refuseAndLog(
          request,
          400,
          'digest must be a SHA-256 in 64 lowercase hex characters',
        );
      }
      const overwriteParam = params.get('overwrite') ?? 'false';
      if (overwriteParam !== 'true' && overwriteParam !== 'false') {
        return yield* refuseAndLog(request, 400, 'overwrite must be true or false');
      }
      const overwrite = overwriteParam === 'true';
      const contentLength = request.headers['content-length'];
      if (contentLength === undefined) {
        return yield* refuseAndLog(request, 411, 'Content-Length is required');
      }
      const size = Number(contentLength);
      if (size > config.maxFileBytes) {
        return yield* refuseAndLog(
          request,
          413,
          `File is over the limit of ${config.maxFileBytes} bytes`,
        );
      }
      if (!(yield* store.isPresent)) {
        return yield* refuseAndLog(request, 503, 'The store is missing');
      }
      const { repository, scope: runScope } = verification.success;
      const uploadLog = { repository, name, size, ...runScope };
      // With the digest, a retried upload or a refusal needs none of the body.
      const held = yield* store.findByName({ scope: runScope, name });
      if (digest !== undefined && Option.isSome(held)) {
        if (held.value.digest === digest) {
          yield* Effect.logInfo('upload already stored').pipe(
            Effect.annotateLogs({
              ...uploadLog,
              token: shortToken(held.value.id),
              digest: held.value.digest,
              expiresAt: held.value.expiresAt.toString(),
            }),
          );
          return yield* answerUnread(request, 200, describeArtifact(held.value));
        }
        if (!overwrite) {
          return yield* refuseAndLog(request, 409, NAME_TAKEN, 'name taken').pipe(
            Effect.annotateLogs(uploadLog),
          );
        }
      }
      if ((yield* store.freeBytes) - size < config.minFreeBytes) {
        return yield* refuseAndLog(request, 507, 'Not enough free space on the server');
      }

      return yield* store
        .put({
          repository,
          scope: runScope,
          name,
          size,
          digest,
          overwrite,
          retentionDays,
          body: request.stream.pipe(
            Stream.mapError(error => new UploadFailedError({ reason: describeError(error) })),
          ),
        })
        .pipe(
          Effect.tap(({ artifact, isNew }) =>
            Effect.logInfo(isNew ? 'upload' : 'upload already stored').pipe(
              Effect.annotateLogs({
                ...uploadLog,
                token: shortToken(artifact.id),
                digest: artifact.digest,
                expiresAt: artifact.expiresAt.toString(),
              }),
            ),
          ),
          Effect.map(({ artifact, isNew }) =>
            respondJson(isNew ? 201 : 200, describeArtifact(artifact)),
          ),
          // In a finalizer, as a failed write breaks the connection, which interrupts this fiber
          // too, and nothing after that would run.
          Effect.onError(cause => {
            const failure = Cause.squash(cause);
            const reason = (() => {
              if (failure instanceof UploadFailedError) return failure.reason;
              return Cause.hasInterruptsOnly(cause) ? 'connection closed' : undefined;
            })();
            if (reason === undefined) return Effect.void;
            return Effect.logInfo('upload stopped').pipe(
              Effect.annotateLogs({ ...uploadLog, reason }),
            );
          }),
          Effect.catchTags({
            UploadFailedError: () => answerUnread(request, 500, { error: 'Upload failed' }),
            ArtifactExistsError: () =>
              Effect.logInfo('upload refused').pipe(
                Effect.annotateLogs({ ...uploadLog, status: 409, reason: 'name taken' }),
                Effect.as(respondJson(409, { error: NAME_TAKEN })),
              ),
            DigestMismatchError: ({ expected, actual }) =>
              Effect.logInfo('upload refused').pipe(
                Effect.annotateLogs({ ...uploadLog, status: 422, expected, actual }),
                Effect.as(
                  respondJson(422, {
                    error: `The body's SHA-256 is ${actual}, not the digest sent, ${expected}. Did the file change while it was uploading?`,
                  }),
                ),
              ),
          }),
        );
    });

    const describeListed = (artifact: ArtifactMeta) => ({
      ...describeArtifact(artifact),
      repositoryId: artifact.repositoryId,
      runId: artifact.runId,
      runAttempt: artifact.runAttempt,
    });

    const list = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const listMatch = ARTIFACTS_URL.exec(request.url);
      if (listMatch === null) return notFound;

      const { repository: ownRepository, scope: ownScope } = yield* authenticate(request);
      const params = new URLSearchParams(listMatch[1] ?? '');
      const repository = params.get('repository') ?? ownRepository;
      if (!REPOSITORY.test(repository)) {
        return yield* refusal(400, 'repository must be in the format owner/name');
      }
      const runId = params.get('run-id') ?? ownScope.runId;
      if (!RUN_ID.test(runId)) return yield* refusal(400, 'run-id must be a number');
      const names = Arr.dedupe(params.getAll('name')).toSorted();
      const ids = params.getAll('id');
      if (names.length > 0 && ids.length > 0) {
        return yield* refusal(400, 'name and id can not be used together');
      }
      if (!ids.every(id => ARTIFACT_ID.test(id))) {
        return yield* refusal(400, "id must be an artifact's ID");
      }
      if (!(yield* store.isPresent)) return yield* refusal(503, 'The store is missing');

      // The token's own repository needs no lookup: it may not have uploaded yet, or been renamed.
      const repositoryId =
        repository.toLowerCase() === ownRepository.toLowerCase()
          ? Option.some(ownScope.repositoryId)
          : yield* store.findRepository(repository);
      if (Option.isNone(repositoryId)) return respondJson(200, { artifacts: [] });
      const run = { repositoryId: repositoryId.value, runId };

      const artifacts = yield* (() => {
        if (names.length === 0) {
          return Effect.map(store.listLatest(run), found =>
            ids.length === 0 ? found : found.filter(({ id }) => ids.includes(id)),
          );
        }
        return Effect.map(
          Effect.forEach(names, name => store.findLatest({ ...run, name }), { concurrency: 1 }),
          Arr.getSomes,
        );
      })();
      yield* Effect.logInfo('list').pipe(
        Effect.annotateLogs({ repository: ownRepository, ...run, count: artifacts.length }),
      );
      return respondJson(200, { artifacts: artifacts.map(describeListed) });
    }, answeringRefusals('list'));

    /** Any repository may read another of the owner's, but only a repository removes its own. */
    const remove = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const [, id] = ARTIFACT_URL.exec(request.url) ?? [];
      if (id === undefined) return notFound;

      const { repository, scope } = yield* authenticate(request);
      if (!(yield* store.isPresent)) return yield* refusal(503, 'The store is missing');
      const removed = yield* store.remove({ id, repositoryId: scope.repositoryId }).pipe(
        Effect.catchTags({
          ArtifactNotFoundError: () => Effect.fail(refusal(404, 'Not found')),
          OtherRepositoryError: () => Effect.fail(refusal(403, OTHER_REPOSITORY)),
        }),
      );
      yield* Effect.logInfo('delete').pipe(
        Effect.annotateLogs({
          repository,
          token: shortToken(id),
          name: removed.name,
          repositoryId: removed.repositoryId,
          runId: removed.runId,
          runAttempt: removed.runAttempt,
        }),
      );
      return respondJson(200, { id, name: removed.name });
    }, answeringRefusals('delete'));

    /**
     * The headers promised the whole file, so the connection has to break: an ended response would
     * leave the client waiting, or reading the next response's bytes as the rest of this one.
     */
    const stopDownload = (request: HttpServerRequest.HttpServerRequest, token: string) =>
      Effect.fnUntraced(function* (exit: Exit.Exit<unknown, unknown>) {
        if (Exit.isSuccess(exit)) return;
        NodeHttpServerRequest.toServerResponse(request).destroy();
        const reason = Cause.hasInterruptsOnly(exit.cause)
          ? 'connection closed'
          : describeError(Cause.squash(exit.cause));
        yield* Effect.logInfo('download stopped').pipe(
          Effect.annotateLogs({ token: shortToken(token), reason }),
        );
      });

    const download = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const [, token, name] = DOWNLOAD_URL.exec(request.url) ?? [];
      const isRead = request.method === 'GET' || request.method === 'HEAD';
      if (token === undefined || name === undefined || !isRead) return notFound;

      const artifact = yield* store.find(token, name);
      if (Option.isNone(artifact)) return notFound;
      const { size, data } = artifact.value;

      yield* Effect.logInfo(request.method).pipe(
        Effect.annotateLogs({ token: shortToken(token), name, size }),
      );
      return HttpServerResponse.stream(data.pipe(Stream.onExit(stopDownload(request, token))), {
        contentLength: size,
        contentType: 'application/octet-stream',
        headers: {
          'content-disposition': `attachment; filename="${name}"`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
        },
      });
    });

    const healthz = Effect.gen(function* () {
      return (yield* store.isPresent)
        ? respondJson(200, { status: 'ok' })
        : respondJson(503, { error: 'The store is missing' });
    });

    /** The one place a fault becomes an answer, and the reason it reaches the log holds no path. */
    const answeringFaults = <E>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E>) =>
      handler.pipe(
        Effect.catchCauseIf(
          cause => !Cause.hasInterruptsOnly(cause),
          cause =>
            Effect.logError('request failed').pipe(
              Effect.annotateLogs({ reason: describeError(Cause.squash(cause)) }),
              Effect.as(respondJson(500, { error: 'Internal error' })),
            ),
        ),
      );

    return HttpRouter.addAll([
      HttpRouter.route('GET', '/healthz', answeringFaults(healthz)),
      HttpRouter.route('POST', '/artifacts', request => answeringFaults(upload(request))),
      HttpRouter.route('GET', '/artifacts', request => answeringFaults(list(request))),
      HttpRouter.route('DELETE', '/artifacts/*', request => answeringFaults(remove(request))),
      HttpRouter.route('*', '*', request => answeringFaults(download(request))),
    ]);
  }),
);

/** Effect's request logger is off: it logs the URL, which holds a full download token. */
export const ArtifactServer = HttpRouter.serve(ArtifactRoutes, { disableLogger: true });
