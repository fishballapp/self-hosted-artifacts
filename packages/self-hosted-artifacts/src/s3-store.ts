import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { ClientError } from './client-support.ts';
import { ConfigError, type S3StoreConfig } from './config.ts';
import { shortToken } from './log.ts';
import {
  attachmentOf,
  isFileName,
  MULTIPART_FROM_BYTES,
  newArtifactId,
  partSizeOf,
} from './protocol.ts';
import {
  checksumOf,
  dataHeadersOf,
  dataKeyOf,
  isExpired,
  makeS3Bucket,
  nameKeyOf,
  readS3Credentials,
  scopeFromHeader,
  UPLOAD_URL_SECONDS,
} from './s3-bucket.ts';
import {
  ArtifactExistsError,
  ArtifactNotFoundError,
  OtherRepositoryError,
  Store,
  UploadNotFoundError,
} from './store-contract.ts';
import type { UnavailableError } from './transport.ts';

// A bucket behind the routes: this holds the keys and checks what a verified job may do, while bytes
// go straight to and from the bucket through URLs with a signature in them. A Worker runs this too, so
// it imports nothing of Node's but `node:crypto`, and doesn't touch `Temporal`.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_SECONDS = 5 * 60;

/** A bucket that failed the request, which the routes answer as any fault. */
class BucketFaultError extends Schema.TaggedError<BucketFaultError>()('BucketFaultError', {
  message: Schema.String,
}) {}

/** What reaches a log names a key, and an artifact's key holds its download token. */
const withoutTokens = (message: string) =>
  message.replaceAll(
    /artifacts\/([A-Za-z0-9_-]{43})/gu,
    (_, id: string) => `artifacts/${shortToken(id)}`,
  );

const orFault = <A>(self: Effect.Effect<A, ClientError | UnavailableError>) =>
  self.pipe(
    Effect.catch(({ message }) =>
      Effect.die(new BucketFaultError({ message: withoutTokens(message) })),
    ),
  );

const expiryAfter = ({ retentionDays, nowMs }: { retentionDays: number; nowMs: number }) =>
  // biome-ignore lint/plugin/no-date: Runs on a Worker, where Temporal is absent: the expiry is the ISO string the store contract holds.
  new Date(nowMs + retentionDays * MS_PER_DAY).toISOString();

export const s3StoreLayer = ({ bucket, region, endpoint }: S3StoreConfig) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const credentials = yield* readS3Credentials.pipe(
        Effect.mapError(({ message }) => new ConfigError({ message })),
      );
      const {
        retrying,
        readHeld,
        deleteObject,
        deleteOrNote,
        latestInRun,
        findRepositoryId,
        recordRepository,
        readDataHead,
        presign,
        startMultipart,
        signParts,
        completeMultipart,
        abortMultipart,
        holdsData,
        commit,
        findLive,
      } = makeS3Bucket({
        client,
        bucket,
        endpoint,
        connection: Effect.succeed({ credentials, region }),
        note: message => Effect.logWarning(withoutTokens(message)),
      });

      return Store.of({
        isPresent: Effect.succeed(true),

        /**
         * What's signed is what S3 holds the `PUT` to: this key, this length and this checksum, so all
         * the URL can write is this file, and its scope, which is what a commit checks.
         */
        create: Effect.fn('S3Store.create')(function* ({ scope, name, size, digest }) {
          const id = newArtifactId();
          const key = dataKeyOf({ id, name });
          if (size >= MULTIPART_FROM_BYTES) {
            const uploadId = yield* orFault(startMultipart({ key, headers: dataHeadersOf(scope) }));
            return { kind: 'multipart', id, uploadId, partSize: partSizeOf(size) } as const;
          }
          const headers = { ...dataHeadersOf(scope), 'x-amz-checksum-sha256': checksumOf(digest) };
          const url = yield* orFault(
            presign({
              method: 'PUT',
              key,
              headers: { ...headers, 'content-length': String(size) },
              expiresInSeconds: UPLOAD_URL_SECONDS,
            }),
          );
          // No `content-length`: `fetch` strips one set by hand, and sets it from the Blob.
          return { kind: 'single', id, url, headers } as const;
        }),

        signParts: ({ id, name, uploadId, size, parts }) =>
          orFault(signParts({ key: dataKeyOf({ id, name }), uploadId, size, parts })),

        abort: ({ id, name, uploadId }) =>
          abortMultipart({ key: dataKeyOf({ id, name }), uploadId }),

        commit: Effect.fn('S3Store.commit')(
          function* ({
            id,
            repository,
            scope,
            name,
            size,
            digest,
            overwrite,
            retentionDays,
            multipart,
          }) {
            const dataKey = dataKeyOf({ id, name });
            if (multipart !== undefined) {
              yield* orFault(completeMultipart({ key: dataKey, ...multipart }));
            }
            const isOurs = yield* orFault(holdsData({ key: dataKey, size, scope }));
            if (!isOurs) return yield* new UploadNotFoundError();

            yield* orFault(
              recordRepository({ repositoryName: repository, repositoryId: scope.repositoryId }),
            );
            const nowMs = yield* Clock.currentTimeMillis;
            const outcome = yield* orFault(
              commit({
                artifact: {
                  ...scope,
                  id,
                  name,
                  size,
                  digest,
                  expiresAt: expiryAfter({ retentionDays, nowMs }),
                },
                overwrite,
              }),
            );
            if (outcome._tag === 'Stored') {
              if (Option.isSome(outcome.replaced)) {
                yield* deleteOrNote(dataKeyOf(outcome.replaced.value));
              }
              return { artifact: outcome.artifact, isNew: outcome.isNew };
            }
            // Whichever this is, this upload's data has no name to be reached by.
            yield* deleteOrNote(dataKey);
            if (outcome._tag === 'AlreadyThere') {
              return { artifact: outcome.artifact, isNew: false };
            }
            return yield* outcome._tag === 'NameTaken'
              ? new ArtifactExistsError()
              : new UploadNotFoundError();
          },
          // A client gone by now is what a retry is for, so this finishes regardless.
          Effect.uninterruptible,
        ),

        findByName: Effect.fn('S3Store.findByName')(function* ({ scope, name }) {
          const held = yield* orFault(retrying(readHeld(nameKeyOf(scope, name))));
          const nowMs = yield* Clock.currentTimeMillis;
          return Option.filter(
            Option.map(held, ({ artifact }) => artifact),
            artifact => !isExpired(artifact, nowMs),
          );
        }),

        findRepository: name => orFault(findRepositoryId(name)),

        listLatest: ({ repositoryId, runId, names = [] }) =>
          orFault(latestInRun({ repositoryId, runId, names })),

        remove: Effect.fn('S3Store.remove')(function* ({ id, repositoryId }) {
          const found = yield* orFault(findLive(id));
          if (Option.isNone(found)) return yield* new ArtifactNotFoundError();
          const { artifact, nameKey, dataKey } = found.value;
          if (artifact.repositoryId !== repositoryId) return yield* new OtherRepositoryError();
          // The name first, which is the commit: with it gone, no link leads to the data.
          yield* orFault(retrying(deleteObject(nameKey)));
          yield* deleteOrNote(dataKey);
          return artifact;
          // A client gone by now shouldn't leave the data to the lifecycle rule.
        }, Effect.uninterruptible),

        /** Two requests: the data's `HEAD` says which scope to look in, and the name decides. */
        findDownload: Effect.fn('S3Store.findDownload')(function* (id, name) {
          // A name reaches a key here, so it's held to the rule first, where a disk only compares it.
          if (!isFileName(name)) return { _tag: 'NotFound' } as const;
          const key = dataKeyOf({ id, name });
          const head = yield* orFault(readDataHead(key));
          const scope = Option.flatMap(head, ({ scope: header }) => scopeFromHeader(header));
          if (Option.isNone(scope)) return { _tag: 'NotFound' } as const;

          const held = yield* orFault(retrying(readHeld(nameKeyOf(scope.value, name))));
          const nowMs = yield* Clock.currentTimeMillis;
          if (
            Option.isNone(held) ||
            held.value.artifact.id !== id ||
            held.value.artifact.name !== name ||
            isExpired(held.value.artifact, nowMs)
          ) {
            return { _tag: 'NotFound' } as const;
          }
          return {
            _tag: 'Redirect',
            size: held.value.artifact.size,
            location: yield* orFault(
              presign({
                method: 'GET',
                key,
                query: { 'response-content-disposition': attachmentOf(name) },
                expiresInSeconds: DOWNLOAD_URL_SECONDS,
              }),
            ),
          } as const;
        }),
      });
    }),
  );
