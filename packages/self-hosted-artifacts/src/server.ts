import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
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
import { type ArtifactMeta, Store, type UploadDeclaration } from './store-contract.ts';

// The routes every store shares, which also run under a Worker's web handler. So this imports nothing
// of Node's, even through what it imports: `server-portability.test.ts` holds that.

const ARTIFACTS_URL = /^\/artifacts(?:\?(.*))?$/;
const ARTIFACT_URL = /^\/artifacts\/([A-Za-z0-9_-]{43})$/;
const UPLOADS_URL = /^\/uploads(?:\?(.*))?$/;
const COMMIT_URL = /^\/uploads\/([A-Za-z0-9_-]{43})\/commit(?:\?(.*))?$/;
const DOWNLOAD_URL = /^\/([A-Za-z0-9_-]{43})\/([^/?#]+)$/;

/** What only the platform under the routes can do. */
export class ResponseBreaker extends Context.Service<
  ResponseBreaker,
  {
    /** Breaks the connection of a response whose body failed after its headers had gone. */
    readonly breakResponse: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<void>;
  }
>()('self-hosted-artifacts/ResponseBreaker') {}

export const respondJson = (status: number, body: unknown) =>
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

/** The one place a fault becomes an answer, and the reason it reaches the log holds no path. */
export const answeringFaults = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
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

export const ArtifactRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const verifier = yield* TokenVerifier;
    const breaker = yield* ResponseBreaker;

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
      expiresAt,
      links: Object.fromEntries(
        Object.entries(config.linkBases).map(([label, base]) => [label, `${base}/${id}/${name}`]),
      ),
    });

    /** What `POST /uploads` and its commit both say. Only the claims say whose it is. */
    const parseDeclaration = Effect.fnUntraced(function* (query: string) {
      const params = new URLSearchParams(query);
      const name = params.get('name');
      if (name === null || !FILE_NAME.test(name)) return yield* refusal(400, FILE_NAME_MESSAGE);
      const retentionDays = parseRetentionDays(params.get('retention-days'), config);
      if (retentionDays === undefined) return yield* refusal(400, BAD_RETENTION);
      const digest = params.get('digest');
      if (digest === null || !SHA_256.test(digest)) {
        return yield* refusal(400, 'digest must be a SHA-256 in 64 lowercase hex characters');
      }
      const overwriteParam = params.get('overwrite') ?? 'false';
      if (overwriteParam !== 'true' && overwriteParam !== 'false') {
        return yield* refusal(400, 'overwrite must be true or false');
      }
      const sizeParam = params.get('size');
      if (sizeParam === null || !/^(?:0|[1-9][0-9]*)$/u.test(sizeParam)) {
        return yield* refusal(400, 'size must be a whole number of bytes');
      }
      const size = Number(sizeParam);
      if (size > config.maxFileBytes) {
        return yield* refusal(413, `File is over the limit of ${config.maxFileBytes} bytes`);
      }
      return { name, size, digest, overwrite: overwriteParam === 'true', retentionDays };
    });

    const uploadLogOf = (
      repository: string,
      { name, size, scope }: Pick<UploadDeclaration, 'name' | 'size' | 'scope'>,
    ) => ({ repository, name, size, ...scope });

    const logStored = (
      message: string,
      uploadLog: ReturnType<typeof uploadLogOf>,
      artifact: ArtifactMeta,
    ) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({
          ...uploadLog,
          token: shortToken(artifact.id),
          digest: artifact.digest,
          expiresAt: artifact.expiresAt,
        }),
      );

    const refuseNameTaken = (uploadLog: ReturnType<typeof uploadLogOf>) =>
      Effect.logInfo('upload refused').pipe(
        Effect.annotateLogs({ ...uploadLog, status: 409, reason: 'name taken' }),
        Effect.as(respondJson(409, { error: NAME_TAKEN })),
      );

    /** With what a job declares, a retry or a refusal needs none of the body. */
    const createUpload = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const uploadsMatch = UPLOADS_URL.exec(request.url);
      if (uploadsMatch === null) return notFound;

      const { repository, scope: runScope } = yield* authenticate(request);
      const declaration = yield* parseDeclaration(uploadsMatch[1] ?? '');
      if (!(yield* store.isPresent)) return yield* refusal(503, 'The store is missing');
      const { name, digest, overwrite } = declaration;
      const uploadLog = uploadLogOf(repository, { ...declaration, scope: runScope });

      const held = yield* store.findByName({ scope: runScope, name });
      if (Option.isSome(held)) {
        if (held.value.digest === digest) {
          yield* logStored('upload already stored', uploadLog, held.value);
          return respondJson(200, describeArtifact(held.value));
        }
        if (!overwrite) return yield* refuseNameTaken(uploadLog);
      }
      const upload = yield* store
        .create({ ...declaration, scope: runScope })
        .pipe(
          Effect.catchTag('NotEnoughSpaceError', () =>
            Effect.fail(refusal(507, 'Not enough free space on the server')),
          ),
        );
      yield* Effect.logInfo('upload started').pipe(
        Effect.annotateLogs({ ...uploadLog, token: shortToken(upload.id) }),
      );
      return respondJson(201, { upload });
    }, answeringRefusals('upload'));

    const commitUpload = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const [, id, query] = COMMIT_URL.exec(request.url) ?? [];
      if (id === undefined) return notFound;

      const { repository, scope: runScope } = yield* authenticate(request);
      const declaration = yield* parseDeclaration(query ?? '');
      if (!(yield* store.isPresent)) return yield* refusal(503, 'The store is missing');
      const uploadLog = uploadLogOf(repository, { ...declaration, scope: runScope });

      return yield* store.commit({ ...declaration, id, repository, scope: runScope }).pipe(
        Effect.tap(({ artifact, isNew }) =>
          logStored(isNew ? 'upload' : 'upload already stored', uploadLog, artifact),
        ),
        Effect.map(({ artifact, isNew }) =>
          respondJson(isNew ? 201 : 200, describeArtifact(artifact)),
        ),
        Effect.catchTags({
          ArtifactExistsError: () => refuseNameTaken(uploadLog),
          UploadNotFoundError: () =>
            Effect.fail(
              refusal(
                404,
                "This upload is not there to commit: its body never arrived, it has expired, or it is another run's",
              ),
            ),
        }),
      );
    }, answeringRefusals('upload'));

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

      const found = yield* store.listLatest({ ...run, names });
      const artifacts = ids.length === 0 ? found : found.filter(({ id }) => ids.includes(id));
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
        yield* breaker.breakResponse(request);
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

      const found = yield* store.findDownload(token, name);
      if (found._tag === 'NotFound') return notFound;

      yield* Effect.logInfo(request.method).pipe(
        Effect.annotateLogs({ token: shortToken(token), name, size: found.size }),
      );
      const fileHeaders = {
        'content-disposition': `attachment; filename="${name}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
      };
      if (found._tag === 'Stream') {
        return HttpServerResponse.stream(
          found.data.pipe(Stream.onExit(stopDownload(request, token))),
          {
            contentLength: found.size,
            contentType: 'application/octet-stream',
            headers: fileHeaders,
          },
        );
      }
      // Answered here, as a store needn't take a `HEAD` at a URL with a signature in it: R2 doesn't.
      if (request.method === 'HEAD') {
        return HttpServerResponse.empty({
          status: 200,
          headers: {
            ...fileHeaders,
            'content-length': String(found.size),
            'content-type': 'application/octet-stream',
          },
        });
      }
      return HttpServerResponse.redirect(found.location, {
        status: 302,
        headers: { 'cache-control': 'no-store' },
      });
    });

    const healthz = Effect.gen(function* () {
      return (yield* store.isPresent)
        ? respondJson(200, { status: 'ok' })
        : respondJson(503, { error: 'The store is missing' });
    });

    return HttpRouter.addAll([
      HttpRouter.route('GET', '/healthz', answeringFaults(healthz)),
      HttpRouter.route('POST', '/uploads', request => answeringFaults(createUpload(request))),
      HttpRouter.route('POST', '/uploads/:id/commit', request =>
        answeringFaults(commitUpload(request)),
      ),
      HttpRouter.route('GET', '/artifacts', request => answeringFaults(list(request))),
      HttpRouter.route('DELETE', '/artifacts/*', request => answeringFaults(remove(request))),
      HttpRouter.route('*', '*', request => answeringFaults(download(request))),
    ]);
  }),
);
