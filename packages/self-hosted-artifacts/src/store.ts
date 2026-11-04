import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Num from 'effect/Number';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import type { DiskStoreConfig } from './config.ts';
import { describeError } from './log.ts';
import { newArtifactId } from './protocol.ts';
import {
  ArtifactExistsError,
  type ArtifactMeta,
  ArtifactMetaSchema,
  ArtifactNotFoundError,
  NotEnoughSpaceError,
  OtherRepositoryError,
  RunNumberSchema,
  type RunScope,
  Store,
  type StoreShape,
  UploadFailedError,
  UploadNotFoundError,
} from './store-contract.ts';

/** Also the server's requestTimeout: enough for 2 GiB at about 5 Mbit/s. An upload URL lasts as long. */
export const UPLOAD_TIMEOUT = Duration.hours(1);
// Node enforces requestTimeout on a 30-second tick, so an upload can outlive it by that much.
const STALE_TEMP_MS = Duration.toMillis(UPLOAD_TIMEOUT) + 60 * 1000;
const SCANNING_CONCURRENCY = 16;
const SWEEP_INTERVAL = Duration.hours(1);

const DATA_FILE = 'data';
const META_FILE = 'meta.json';
const UPLOAD_FILE = 'upload.json';
/** `runs/<repository>/<run>/<attempt>/`, then a file for each name. */
const RUN_SCOPE_LEVELS = 3;

const MetaFileSchema = Schema.fromJsonString(ArtifactMetaSchema);
const decodeMeta = Schema.decodeUnknownOption(MetaFileSchema);
const encodeMeta = Schema.encodeEffect(MetaFileSchema);

/** What a job declared of an upload it has started: all there is of an upload until it's committed. */
const PendingUploadSchema = Schema.Struct({
  id: Schema.String,
  repositoryId: RunNumberSchema,
  runId: RunNumberSchema,
  runAttempt: RunNumberSchema,
  name: Schema.String,
  size: Schema.Finite,
  digest: Schema.String,
  overwrite: Schema.Boolean,
  retentionDays: Schema.Finite,
  createdAtMs: Schema.Finite,
});
export type PendingUpload = typeof PendingUploadSchema.Type;

const UploadFileSchema = Schema.fromJsonString(PendingUploadSchema);
const decodeUpload = Schema.decodeUnknownOption(UploadFileSchema);
const encodeUpload = Schema.encodeEffect(UploadFileSchema);

/** What a repository's name means now. A rename leaves the old name's file until nothing uses it. */
const RepositoryFileSchema = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, repositoryId: RunNumberSchema }),
);
const decodeRepository = Schema.decodeUnknownOption(RepositoryFileSchema);
const encodeRepository = Schema.encodeEffect(RepositoryFileSchema);

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

const isMissing = ({ reason }: PlatformError.PlatformError) =>
  reason._tag === 'NotFound' || reason._tag === 'BadResource';

const orNoneIfMissing = <A>(
  self: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<Option.Option<A>> =>
  self.pipe(
    Effect.asSome,
    Effect.catchIf(isMissing, () => Effect.succeed(Option.none<A>())),
    Effect.orDie,
  );

/** The body isn't what its digest said. */
export class DigestMismatchError extends Schema.TaggedError<DigestMismatchError>()(
  'DigestMismatchError',
  { expected: Schema.String, actual: Schema.String },
) {}

const uploadFailed = (error: unknown) => new UploadFailedError({ reason: describeError(error) });

const countedTo =
  (expectedSize: number) =>
  <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E | UploadFailedError> =>
    Stream.suspend(() => {
      let received = 0;
      return body.pipe(
        Stream.tap(chunk => {
          received += chunk.length;
          return received > expectedSize
            ? Effect.fail(
                new UploadFailedError({ reason: 'body is longer than its Content-Length' }),
              )
            : Effect.void;
        }),
        Stream.concat(
          Stream.suspend(() =>
            received === expectedSize
              ? Stream.empty
              : Stream.fail(
                  new UploadFailedError({ reason: 'body is shorter than its Content-Length' }),
                ),
          ),
        ),
      );
    });

/** The disk's own part of a store: the body comes to this process, and leaves temp files to sweep. */
export class DiskStore extends Context.Service<
  DiskStore,
  StoreShape & {
    /** An upload that can still take its body. */
    readonly findUpload: (id: string) => Effect.Effect<Option.Option<PendingUpload>>;
    /**
     * Takes an upload's body, in place only once it has all arrived and matches its digest. Another
     * try replaces it, and a body that doesn't match ends the upload.
     */
    readonly receive: (body: {
      readonly upload: PendingUpload;
      readonly stream: Stream.Stream<Uint8Array, UploadFailedError>;
    }) => Effect.Effect<
      void,
      UploadFailedError | UploadNotFoundError | DigestMismatchError | NotEnoughSpaceError
    >;
    /** Removes expired artifacts, anything a crash left unconnected, and dead uploads. */
    readonly sweep: Effect.Effect<{
      readonly removedNames: number;
      readonly removedArtifacts: number;
      readonly removedTemps: number;
      readonly removedRepositories: number;
    }>;
  }
>()('self-hosted-artifacts/DiskStore') {
  static readonly layer = ({ dir, minFreeBytes }: DiskStoreConfig) =>
    Layer.effect(
      DiskStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = path.join(dir, 'tmp');
        const artifactsDir = path.join(dir, 'artifacts');
        const runsDir = path.join(dir, 'runs');
        const repositoriesDir = path.join(dir, 'repositories');
        // One server per store. Changing what a name refers to reads it first, and a sweep decides
        // from what it reads, so none of these may interleave.
        const publishing = yield* Semaphore.make(1);

        const readMetaFile = (file: string) =>
          orNoneIfMissing(fs.readFileString(file)).pipe(
            Effect.map(Option.flatMap(text => decodeMeta(text))),
          );

        const metaFileOf = (id: string) => path.join(artifactsDir, id, META_FILE);

        const readUploadFile = (id: string) =>
          orNoneIfMissing(fs.readFileString(path.join(tempDir, id, UPLOAD_FILE))).pipe(
            Effect.map(Option.flatMap(text => decodeUpload(text))),
          );

        /** A hash, so a name never reaches a path, and a case-insensitive disk keeps names apart. */
        const nameFileOf = ({ repositoryId, runId, runAttempt }: RunScope, name: string) =>
          path.join(runsDir, repositoryId, runId, runAttempt, `${sha256Hex(name)}.json`);

        /** Lower case, as GitHub's names are one repository whatever their case. */
        const repositoryFileOf = (name: string) =>
          path.join(repositoriesDir, `${sha256Hex(name.toLowerCase())}.json`);

        const readRepositoryFile = (file: string) =>
          orNoneIfMissing(fs.readFileString(file)).pipe(
            Effect.map(Option.flatMap(text => decodeRepository(text))),
          );

        const isExpired = ({ expiresAt }: ArtifactMeta) =>
          Effect.map(Clock.currentTimeMillis, now => now >= Date.parse(expiresAt));

        const removeDirectory = (target: string) =>
          fs.remove(target, { recursive: true, force: true }).pipe(Effect.orDie);

        /**
         * The store's directories are created one level at a time, and never `recursive`: with the
         * store missing that would create it, and a directory at a volume's mount path sends the real
         * disk elsewhere when it mounts.
         */
        const ensureSubdirectory = (target: string) =>
          fs.makeDirectory(target).pipe(
            Effect.catchIf(
              ({ reason }) => reason._tag === 'AlreadyExists',
              () => Effect.void,
            ),
          );

        const ensureScopeDirectory = ({ repositoryId, runId, runAttempt }: RunScope) =>
          Effect.forEach(
            [[], [repositoryId], [repositoryId, runId], [repositoryId, runId, runAttempt]],
            segments => ensureSubdirectory(path.join(runsDir, ...segments)),
            { concurrency: 1, discard: true },
          );

        const listEntries = (parent: string) =>
          orNoneIfMissing(fs.readDirectory(parent)).pipe(
            Effect.map((found): readonly string[] => Option.getOrElse(found, () => [])),
          );

        /** Written before the name, so an artifact can always be found through its repository. */
        const recordRepository = Effect.fnUntraced(function* (
          name: string,
          { id, repositoryId }: ArtifactMeta,
        ) {
          const file = repositoryFileOf(name);
          const current = yield* readRepositoryFile(file);
          if (Option.exists(current, known => known.repositoryId === repositoryId)) return;
          const replacement = path.join(tempDir, `${id}.repository`);
          const encoded = yield* encodeRepository({ name, repositoryId }).pipe(Effect.orDie);
          yield* fs.writeFileString(replacement, encoded);
          yield* fs.rename(replacement, file);
        });

        /**
         * Publishes an upload's finished temp under its name, unless the scope holds that name already.
         * The directory moves first, so a name never refers to something that isn't there, and a
         * crash before the name is written leaves an artifact no name refers to, for the sweep.
         */
        const publish = Effect.fnUntraced(function* ({
          repository,
          artifact,
          temp,
          overwrite,
          current,
        }: {
          repository: string;
          artifact: ArtifactMeta;
          temp: string;
          overwrite: boolean;
          current: Option.Option<ArtifactMeta>;
        }) {
          if (Option.isSome(current) && !(yield* isExpired(current.value))) {
            if (current.value.digest === artifact.digest) {
              return { artifact: current.value, isNew: false, replaced: Option.none<string>() };
            }
            if (!overwrite) return yield* new ArtifactExistsError();
          }
          const meta = yield* encodeMeta(artifact).pipe(Effect.orDie);
          yield* fs.writeFileString(path.join(temp, META_FILE), meta);
          yield* fs.remove(path.join(temp, UPLOAD_FILE));
          const published = path.join(artifactsDir, artifact.id);
          yield* fs.rename(temp, published);
          yield* ensureScopeDirectory(artifact);
          yield* recordRepository(repository, artifact);
          const nameFile = nameFileOf(artifact, artifact.name);
          const metaFile = path.join(published, META_FILE);
          if (Option.isNone(current)) {
            // A link can't overwrite, and arrives whole, so a name can't be taken twice or torn.
            yield* fs.link(metaFile, nameFile);
          } else {
            const replacement = path.join(tempDir, `${artifact.id}.name`);
            yield* fs.link(metaFile, replacement);
            yield* fs.rename(replacement, nameFile);
          }
          return { artifact, isNew: true, replaced: Option.map(current, ({ id }) => id) };
        });

        const removeEntries = Effect.fnUntraced(function* (
          parent: string,
          removeEntry: (entry: string) => Effect.Effect<boolean>,
        ) {
          const removed = yield* Effect.filter(yield* listEntries(parent), removeEntry, {
            concurrency: SCANNING_CONCURRENCY,
          });
          return removed.length;
        });

        /** Looks without the permit first, so scanning what's alive never holds up a publish. */
        const removeIfDead = Effect.fnUntraced(function* (
          target: string,
          isDead: Effect.Effect<boolean>,
        ) {
          if (!(yield* isDead)) return false;
          return yield* publishing.withPermit(
            Effect.gen(function* () {
              if (!(yield* isDead)) return false;
              yield* removeDirectory(target);
              return true;
              // Node can't cancel a removal, so an interrupt would release the permit with it still
              // running, and it could then delete what the next upload publishes.
            }).pipe(Effect.uninterruptible),
          );
        });

        const isStaleTemp = (temp: string) =>
          Effect.gen(function* () {
            const stats = yield* orNoneIfMissing(fs.stat(path.join(tempDir, temp)));
            const now = yield* Clock.currentTimeMillis;
            // An upload's directory is touched when it's created and when its body lands, and a body
            // on its way is its own file, touched as it's written. So this holds any upload the
            // request timeout hasn't yet ended.
            return Option.exists(
              Option.flatMap(stats, ({ mtime }) => mtime),
              mtime => now - mtime.getTime() > STALE_TEMP_MS,
            );
          });

        const isDeadName = Effect.fnUntraced(function* (nameFile: string) {
          const artifact = yield* readMetaFile(nameFile);
          if (Option.isNone(artifact) || (yield* isExpired(artifact.value))) return true;
          return Option.isNone(yield* readMetaFile(metaFileOf(artifact.value.id)));
        });

        const isDeadArtifact = Effect.fnUntraced(function* (id: string) {
          const artifact = yield* readMetaFile(metaFileOf(id));
          if (Option.isNone(artifact) || (yield* isExpired(artifact.value))) return true;
          const named = yield* readMetaFile(nameFileOf(artifact.value, artifact.value.name));
          return !Option.exists(named, current => current.id === id);
        });

        /** Dead once no run of it is left, which the same permit keeps a publish from changing. */
        const isDeadRepository = Effect.fnUntraced(function* (file: string) {
          const repository = yield* readRepositoryFile(file);
          if (Option.isNone(repository)) return true;
          const runs = path.join(runsDir, repository.value.repositoryId);
          return Option.isNone(yield* orNoneIfMissing(fs.stat(runs)));
        });

        /** Newest first, compared as numbers: attempt 10 follows attempt 9. */
        const attemptsOf = ({ repositoryId, runId }: { repositoryId: string; runId: string }) =>
          Effect.map(listEntries(path.join(runsDir, repositoryId, runId)), attempts =>
            attempts.toSorted((a, b) => Number(b) - Number(a)),
          );

        const whereLive = (artifacts: readonly ArtifactMeta[]) =>
          Effect.filter(artifacts, artifact => Effect.map(isExpired(artifact), isDead => !isDead), {
            concurrency: 1,
          });

        /** Sweeps the names `levels` below `directory`, then each directory that leaves empty. */
        const sweepNames = Effect.fnUntraced(function* (
          directory: string,
          levels: number,
        ): Effect.fn.Return<number> {
          if (levels === 0) {
            return yield* removeEntries(directory, entry => {
              const nameFile = path.join(directory, entry);
              return removeIfDead(nameFile, isDeadName(nameFile));
            });
          }
          const removed = yield* Effect.forEach(
            yield* listEntries(directory),
            Effect.fnUntraced(function* (entry) {
              const child = path.join(directory, entry);
              const removedBelow = yield* sweepNames(child, levels - 1);
              yield* publishing.withPermit(
                Effect.gen(function* () {
                  if ((yield* listEntries(child)).length === 0) yield* removeDirectory(child);
                  // As in `removeIfDead`: this could otherwise delete a scope a publish just used.
                }).pipe(Effect.uninterruptible),
              );
              return removedBelow;
            }),
            { concurrency: 1 },
          );
          return Num.sumAll(removed);
        });

        /** Whether this file would leave the room the store is meant to keep, as of now. */
        const ensureRoomFor = Effect.fnUntraced(function* (size: number) {
          const { bavail, bsize } = yield* Effect.tryPromise(() => statfs(dir)).pipe(Effect.orDie);
          if (bavail * bsize - size < minFreeBytes) return yield* new NotEnoughSpaceError();
        });

        return DiskStore.of({
          isPresent: orNoneIfMissing(fs.stat(dir)).pipe(
            Effect.map(Option.exists(({ type }) => type === 'Directory')),
          ),

          create: Effect.fn('Store.create')(
            function* ({ scope, name, size, digest, overwrite, retentionDays }) {
              yield* ensureRoomFor(size);
              yield* ensureSubdirectory(tempDir);
              yield* ensureSubdirectory(artifactsDir);
              yield* ensureSubdirectory(repositoriesDir);
              const id = newArtifactId();
              const createdAtMs = yield* Clock.currentTimeMillis;
              const upload = yield* encodeUpload({
                ...scope,
                id,
                name,
                size,
                digest,
                overwrite,
                retentionDays,
                createdAtMs,
              }).pipe(Effect.orDie);
              yield* fs.makeDirectory(path.join(tempDir, id));
              yield* fs.writeFileString(path.join(tempDir, id, UPLOAD_FILE), upload);
              return {
                id,
                url: `/uploads/${id}`,
                headers: { 'content-type': 'application/octet-stream' },
              };
            },
            Effect.catchTag('PlatformError', Effect.die),
          ),

          findUpload: Effect.fn('DiskStore.findUpload')(function* (id) {
            const upload = yield* readUploadFile(id);
            const now = yield* Clock.currentTimeMillis;
            return Option.filter(
              upload,
              ({ createdAtMs }) => now < createdAtMs + Duration.toMillis(UPLOAD_TIMEOUT),
            );
          }),

          receive: Effect.fn('DiskStore.receive')(function* ({
            upload: { id, size, digest: expected },
            stream,
          }) {
            // Again, as an upload's URL can be held for its hour while others fill the disk.
            yield* ensureRoomFor(size);
            // Beside the upload's directory rather than in it, as that may move while this writes.
            const part = path.join(tempDir, `${id}.${newArtifactId()}`);
            yield* Effect.gen(function* () {
              const hash = createHash('sha256');
              yield* stream.pipe(
                countedTo(size),
                Stream.tap(chunk => Effect.sync(() => hash.update(chunk))),
                Stream.run(fs.sink(part)),
              );
              const actual = hash.digest('hex');
              if (actual !== expected) {
                // With the permit, as a commit may be moving what this removes.
                yield* removeIfDead(path.join(tempDir, id), Effect.succeed(true));
                return yield* new DigestMismatchError({ expected, actual });
              }
              // With the upload committed since, there's nowhere for this to go, which is a refusal.
              yield* fs
                .rename(part, path.join(tempDir, id, DATA_FILE))
                .pipe(Effect.catchIf(isMissing, () => Effect.fail(new UploadNotFoundError())));
            }).pipe(
              Effect.catchTag('PlatformError', error => Effect.fail(uploadFailed(error))),
              Effect.ensuring(removeDirectory(part)),
            );
          }),

          commit: Effect.fn('Store.commit')(
            function* ({ id, repository, scope, name, size, digest, overwrite, retentionDays }) {
              const temp = path.join(tempDir, id);
              const outcome = yield* publishing
                .withPermit(
                  Effect.gen(function* () {
                    const current = yield* readMetaFile(nameFileOf(scope, name));
                    if (
                      Option.isSome(current) &&
                      current.value.id === id &&
                      !(yield* isExpired(current.value))
                    ) {
                      return {
                        artifact: current.value,
                        isNew: false,
                        replaced: Option.none<string>(),
                      };
                    }
                    const upload = yield* readUploadFile(id);
                    const isDeclared = Option.exists(
                      upload,
                      declared =>
                        declared.repositoryId === scope.repositoryId &&
                        declared.runId === scope.runId &&
                        declared.runAttempt === scope.runAttempt &&
                        declared.name === name &&
                        declared.size === size &&
                        declared.digest === digest &&
                        declared.overwrite === overwrite &&
                        declared.retentionDays === retentionDays,
                    );
                    if (!isDeclared || !(yield* fs.exists(path.join(temp, DATA_FILE)))) {
                      return yield* new UploadNotFoundError();
                    }
                    const now = yield* Clock.currentTimeMillis;
                    const expiresAt = Temporal.Instant.fromEpochMilliseconds(now)
                      .add({ hours: retentionDays * 24 })
                      .toString();
                    return yield* publish({
                      repository,
                      artifact: { ...scope, id, name, size, digest, expiresAt },
                      temp,
                      overwrite,
                      current,
                    });
                  }),
                )
                .pipe(
                  Effect.tapError(error =>
                    error._tag === 'ArtifactExistsError' ? removeDirectory(temp) : Effect.void,
                  ),
                );
              // A published upload has already moved, so this finds nothing.
              yield* removeDirectory(temp);
              if (Option.isSome(outcome.replaced)) {
                yield* removeDirectory(path.join(artifactsDir, outcome.replaced.value));
              }
              return { artifact: outcome.artifact, isNew: outcome.isNew };
            },
            Effect.catchTag('PlatformError', Effect.die),
            // A client gone by now is what a retry is for, so this finishes regardless.
            Effect.uninterruptible,
          ),

          findByName: Effect.fn('Store.findByName')(function* ({ scope, name }) {
            const artifact = yield* readMetaFile(nameFileOf(scope, name));
            if (Option.isNone(artifact) || (yield* isExpired(artifact.value))) return Option.none();
            return artifact;
          }),

          findRepository: Effect.fn('Store.findRepository')(function* (name) {
            const repository = yield* readRepositoryFile(repositoryFileOf(name));
            return Option.map(repository, ({ repositoryId }) => repositoryId);
          }),

          listLatest: Effect.fn('Store.listLatest')(function* ({
            repositoryId,
            runId,
            names = [],
          }) {
            const attempts = yield* attemptsOf({ repositoryId, runId });
            if (names.length > 0) {
              const latest = yield* Effect.forEach(
                names,
                Effect.fnUntraced(function* (name) {
                  const held = yield* Effect.forEach(
                    attempts,
                    runAttempt =>
                      readMetaFile(nameFileOf({ repositoryId, runId, runAttempt }, name)),
                    { concurrency: SCANNING_CONCURRENCY },
                  );
                  return Arr.head(yield* whereLive(Arr.getSomes(held)));
                }),
                { concurrency: 1 },
              );
              return Arr.sort(
                Arr.getSomes(latest),
                Order.mapInput(Order.String, ({ name }: ArtifactMeta) => name),
              );
            }
            const perAttempt = yield* Effect.forEach(
              attempts,
              Effect.fnUntraced(function* (runAttempt) {
                const directory = path.join(runsDir, repositoryId, runId, runAttempt);
                const held = yield* Effect.forEach(
                  yield* listEntries(directory),
                  entry => readMetaFile(path.join(directory, entry)),
                  { concurrency: SCANNING_CONCURRENCY },
                );
                return yield* whereLive(Arr.getSomes(held));
              }),
              { concurrency: 1 },
            );
            // Oldest first, so the latest attempt's entry for a name is the one a Map keeps.
            const byName = new Map(
              perAttempt.toReversed().flatMap(held => held.map(meta => [meta.name, meta] as const)),
            );
            return Arr.sort(
              byName.values(),
              Order.mapInput(Order.String, ({ name }: ArtifactMeta) => name),
            );
          }),

          remove: Effect.fn('Store.remove')(function* ({ id, repositoryId }) {
            const artifact = yield* publishing.withPermit(
              Effect.gen(function* () {
                const meta = yield* readMetaFile(metaFileOf(id));
                if (Option.isNone(meta) || (yield* isExpired(meta.value))) {
                  return yield* new ArtifactNotFoundError();
                }
                const nameFile = nameFileOf(meta.value, meta.value.name);
                const named = yield* readMetaFile(nameFile);
                if (!Option.exists(named, current => current.id === id)) {
                  return yield* new ArtifactNotFoundError();
                }
                if (meta.value.repositoryId !== repositoryId) {
                  return yield* new OtherRepositoryError();
                }
                yield* fs.remove(nameFile).pipe(Effect.orDie);
                return meta.value;
              }),
            );
            // With its name gone, nothing can read this or reuse its ID, so it needs no permit.
            yield* removeDirectory(path.join(artifactsDir, id));
            return artifact;
            // A client gone by now shouldn't leave the files to a sweep. A crash here does, safely.
          }, Effect.uninterruptible),

          findDownload: Effect.fn('Store.findDownload')(function* (id, name) {
            const meta = yield* readMetaFile(metaFileOf(id));
            if (Option.isNone(meta) || meta.value.id !== id || meta.value.name !== name) {
              return { _tag: 'NotFound' } as const;
            }
            if (yield* isExpired(meta.value)) return { _tag: 'NotFound' } as const;
            const named = yield* readMetaFile(nameFileOf(meta.value, name));
            if (!Option.exists(named, current => current.id === id)) {
              return { _tag: 'NotFound' } as const;
            }
            return {
              _tag: 'Stream',
              size: meta.value.size,
              // Counted, as a file cut short by a power cut would otherwise end the response early,
              // short of its Content-Length, and leave the client waiting.
              data: fs
                .stream(path.join(artifactsDir, id, DATA_FILE))
                .pipe(countedTo(meta.value.size)),
            } as const;
          }),

          // Names first: an expired artifact loses its name before its file, and with a crash between,
          // what is left is an artifact no name refers to.
          sweep: Effect.all(
            {
              removedNames: sweepNames(runsDir, RUN_SCOPE_LEVELS),
              removedArtifacts: removeEntries(artifactsDir, id =>
                removeIfDead(path.join(artifactsDir, id), isDeadArtifact(id)),
              ),
              removedTemps: removeEntries(tempDir, temp =>
                removeIfDead(path.join(tempDir, temp), isStaleTemp(temp)),
              ),
              // After the names, as a repository whose last run just went is what this looks for.
              removedRepositories: removeEntries(repositoriesDir, entry => {
                const file = path.join(repositoriesDir, entry);
                return removeIfDead(file, isDeadRepository(file));
              }),
            },
            { concurrency: 1 },
          ),
        });
      }),
    );

  /** The disk as the routes see it, and as what's only the disk's. */
  static readonly layerWithStore = (config: DiskStoreConfig) =>
    Layer.effect(Store, Effect.service(DiskStore)).pipe(
      Layer.provideMerge(DiskStore.layer(config)),
    );
}

/** The sweep at startup and hourly. One that fails is logged, and the next one tries again. */
export const StoreSweeps = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* DiskStore;
    yield* store.sweep.pipe(
      Effect.tap(counts => Effect.logInfo('sweep').pipe(Effect.annotateLogs(counts))),
      Effect.catchCauseIf(
        cause => !Cause.hasInterruptsOnly(cause),
        cause =>
          Effect.logError('sweep failed').pipe(
            Effect.annotateLogs({ reason: describeError(Cause.squash(cause)) }),
          ),
      ),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
