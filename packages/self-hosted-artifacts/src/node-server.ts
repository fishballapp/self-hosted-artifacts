import { createServer, type Server } from 'node:http';
import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest';
import * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { describeError, shortToken } from './log.ts';
import { ArtifactRoutes, answeringFaults, ResponseBreaker, respondJson } from './server.ts';
import { DiskStore, UPLOAD_TIMEOUT } from './store.ts';
import { UploadFailedError } from './store-contract.ts';

const UPLOAD_URL = /^\/uploads\/([A-Za-z0-9_-]{43})$/;
const NO_SUCH_UPLOAD = 'No such upload: it has expired, or is already committed';
const UNREAD_BODY_GRACE = Duration.seconds(5);
// A client that stops reading or sending gets cut off, so a stalled download can't keep an expired
// file's blocks on disk after its sweep. Long enough for a phone to return from the background. With
// a write pending, Node restarts this timer, so a stalled download goes at two or three times this.
const IDLE_TIMEOUT = Duration.minutes(5);

/** The Node server under the routes, with the timeouts `NodeHttpServer` has no option for. */
export const makeNodeServer = (idleTimeoutMs = Duration.toMillis(IDLE_TIMEOUT)): Server => {
  const server = createServer();
  server.requestTimeout = Duration.toMillis(UPLOAD_TIMEOUT);
  server.timeout = idleTimeoutMs;
  return server;
};

/** `PUT /uploads/<id>`, which only a store that takes the body itself has. The URL is the capability. */
const DiskUploadRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* DiskStore;
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

    const receiveBody = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const [, id] = UPLOAD_URL.exec(request.url) ?? [];
      const found = id === undefined ? Option.none() : yield* store.findUpload(id);
      if (Option.isNone(found)) return yield* answerUnread(request, 404, { error: NO_SUCH_UPLOAD });

      const upload = found.value;
      const { name, size, repositoryId, runId, runAttempt } = upload;
      const uploadLog = {
        name,
        size,
        repositoryId,
        runId,
        runAttempt,
        token: shortToken(upload.id),
      };
      if (request.headers['content-length'] !== String(size)) {
        yield* Effect.logInfo('upload refused').pipe(
          Effect.annotateLogs({ ...uploadLog, status: 400, reason: 'wrong Content-Length' }),
        );
        return yield* answerUnread(request, 400, {
          error: `Content-Length must be ${size}, the size declared`,
        });
      }

      return yield* store
        .receive({
          upload,
          stream: request.stream.pipe(
            Stream.mapError(error => new UploadFailedError({ reason: describeError(error) })),
          ),
        })
        .pipe(
          Effect.tap(() => Effect.logInfo('upload received').pipe(Effect.annotateLogs(uploadLog))),
          Effect.as(respondJson(200, {})),
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
            NotEnoughSpaceError: () =>
              answerUnread(request, 507, { error: 'Not enough free space on the server' }),
            UploadNotFoundError: () => Effect.succeed(respondJson(404, { error: NO_SUCH_UPLOAD })),
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

    return HttpRouter.addAll([
      HttpRouter.route('PUT', '/uploads/:id', request => answeringFaults(receiveBody(request))),
    ]);
  }),
);

const NodeResponseBreaker = Layer.succeed(
  ResponseBreaker,
  ResponseBreaker.of({
    breakResponse: request =>
      Effect.sync(() => {
        NodeHttpServerRequest.toServerResponse(request).destroy();
      }),
  }),
);

/** Effect's request logger is off: it logs the URL, which holds a full download token or upload ID. */
const serve = <E, R>(routes: Layer.Layer<never, E, R | HttpRouter.HttpRouter>) =>
  HttpRouter.serve(routes, { disableLogger: true });

/** With a disk, whose bodies come here. */
export const ArtifactServer = serve(
  Layer.mergeAll(ArtifactRoutes, DiskUploadRoutes).pipe(Layer.provide(NodeResponseBreaker)),
);

/** With a bucket, whose bodies go straight to it, so there is no route to take one. */
export const BucketArtifactServer = serve(ArtifactRoutes.pipe(Layer.provide(NodeResponseBreaker)));
