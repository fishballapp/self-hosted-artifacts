import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Num from 'effect/Number';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import { ServerConfig } from './config.ts';
import { describeError } from './log.ts';

/** Also the server's requestTimeout: enough for 2 GiB at about 5 Mbit/s. */
export const UPLOAD_TIMEOUT = Duration.hours(1);
// Node enforces requestTimeout on a 30-second tick, so an upload can outlive it by that much.
const STALE_TEMP_MS = Duration.toMillis(UPLOAD_TIMEOUT) + 60 * 1000;
const SCANNING_CONCURRENCY = 16;
const SWEEP_INTERVAL = Duration.hours(1);

const DATA_FILE = 'data';
const META_FILE = 'meta.json';
/** `runs/<repository>/<run>/<attempt>/`, then a file for each name. */
const RUN_SCOPE_LEVELS = 3;

const InstantFromStringSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.instanceOf(Temporal.Instant),
    SchemaTransformation.transformEffect({
      decode: text =>
        Effect.try({
          try: () => Temporal.Instant.from(text),
          catch: () => new SchemaIssue.InvalidValue({ message: 'not an instant' }),
        }),
      encode: instant => Effect.succeed(instant.toString()),
    }),
  ),
);

/** A number GitHub assigned. Digits only, as these become directories. */
export const RunNumberSchema = Schema.String.check(Schema.isPattern(/^[0-9]+$/u));

/** Where a name means one artifact. Comes from a verified token, never from the request. */
export type RunScope = {
  readonly repositoryId: string;
  readonly runId: string;
  readonly runAttempt: string;
};

const ArtifactMetaSchema = Schema.Struct({
  id: Schema.String,
  repositoryId: RunNumberSchema,
  runId: RunNumberSchema,
  runAttempt: RunNumberSchema,
  name: Schema.String,
  size: Schema.Finite,
  digest: Schema.String,
  expiresAt: InstantFromStringSchema,
});
export type ArtifactMeta = typeof ArtifactMetaSchema.Type;

const MetaFileSchema = Schema.fromJsonString(ArtifactMetaSchema);
const decodeMeta = Schema.decodeUnknownOption(MetaFileSchema);
const encodeMeta = Schema.encodeEffect(MetaFileSchema);

/** An upload that didn't become an artifact. `reason` is safe to log: it holds no path. */
export class UploadFailedError extends Schema.TaggedError<UploadFailedError>()(
  'UploadFailedError',
  { reason: Schema.String },
) {}

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

/** The scope already holds this name, with other content, and the upload didn't ask to replace it. */
export class ArtifactExistsError extends Schema.TaggedError<ArtifactExistsError>()(
  'ArtifactExistsError',
  {},
) {}

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

export class Store extends Context.Service<
  Store,
  {
    readonly isPresent: Effect.Effect<boolean>;
    readonly freeBytes: Effect.Effect<number>;
    /**
     * Stores the body, then publishes it under its name, which is the only commit. `isNew` is false
     * when the scope already held the same content: the answer is then that artifact, unchanged.
     */
    readonly put: (upload: {
      readonly scope: RunScope;
      readonly name: string;
      readonly size: number;
      readonly digest: string | undefined;
      readonly overwrite: boolean;
      readonly retentionDays: number;
      readonly body: Stream.Stream<Uint8Array, UploadFailedError>;
    }) => Effect.Effect<
      { readonly artifact: ArtifactMeta; readonly isNew: boolean },
      UploadFailedError | ArtifactExistsError | DigestMismatchError
    >;
    /** What a name in a scope refers to now, unless that has expired. */
    readonly findByName: (named: {
      readonly scope: RunScope;
      readonly name: string;
    }) => Effect.Effect<Option.Option<ArtifactMeta>>;
    /**
     * The artifact only under its exact ID and name, while its name still refers to it, and never
     * once it has expired.
     */
    readonly find: (
      id: string,
      name: string,
    ) => Effect.Effect<
      Option.Option<
        ArtifactMeta & {
          readonly data: Stream.Stream<Uint8Array, PlatformError.PlatformError | UploadFailedError>;
        }
      >
    >;
    /** Removes expired artifacts, anything a crash left unconnected, and dead uploads. */
    readonly sweep: Effect.Effect<{
      readonly removedNames: number;
      readonly removedArtifacts: number;
      readonly removedTemps: number;
    }>;
  }
>()('self-hosted-artifacts/Store') {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const { storeDir: dir } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = path.join(dir, 'tmp');
      const artifactsDir = path.join(dir, 'artifacts');
      const runsDir = path.join(dir, 'runs');
      // One server per store. Changing what a name refers to reads it first, and a sweep decides
      // from what it reads, so none of these may interleave.
      const publishing = yield* Semaphore.make(1);

      const currentInstant = Effect.map(
        Clock.currentTimeMillis,
        Temporal.Instant.fromEpochMilliseconds,
      );

      const readMetaFile = (file: string) =>
        orNoneIfMissing(fs.readFileString(file)).pipe(
          Effect.map(Option.flatMap(text => decodeMeta(text))),
        );

      const metaFileOf = (id: string) => path.join(artifactsDir, id, META_FILE);

      /** A hash, so a name never reaches a path, and a case-insensitive disk keeps names apart. */
      const nameFileOf = ({ repositoryId, runId, runAttempt }: RunScope, name: string) =>
        path.join(
          runsDir,
          repositoryId,
          runId,
          runAttempt,
          `${createHash('sha256').update(name).digest('hex')}.json`,
        );

      const isExpired = ({ expiresAt }: ArtifactMeta) =>
        Effect.map(currentInstant, now => Temporal.Instant.compare(now, expiresAt) >= 0);

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

      /**
       * Publishes a finished temp under its name, unless the scope holds that name already.
       * The directory moves first, so a name never refers to something that isn't there, and a
       * crash before the name is written leaves an artifact no name refers to, for the sweep.
       */
      const publish = Effect.fnUntraced(function* ({
        artifact,
        temp,
        overwrite,
      }: {
        artifact: ArtifactMeta;
        temp: string;
        overwrite: boolean;
      }) {
        const nameFile = nameFileOf(artifact, artifact.name);
        const published = path.join(artifactsDir, artifact.id);
        const outcome = yield* publishing.withPermit(
          Effect.gen(function* () {
            const current = yield* readMetaFile(nameFile);
            if (Option.isSome(current) && !(yield* isExpired(current.value))) {
              if (current.value.digest === artifact.digest) {
                return { artifact: current.value, isNew: false, replaced: Option.none() };
              }
              if (!overwrite) return yield* new ArtifactExistsError();
            }
            yield* fs.rename(temp, published);
            yield* ensureScopeDirectory(artifact);
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
          }),
        );
        if (Option.isSome(outcome.replaced)) {
          yield* removeDirectory(path.join(artifactsDir, outcome.replaced.value));
        }
        return { artifact: outcome.artifact, isNew: outcome.isNew };
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
          // A temp's directory is touched when the upload starts and when it ends, not while it
          // writes, so this holds any upload the request timeout hasn't yet ended.
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

      return Store.of({
        isPresent: orNoneIfMissing(fs.stat(dir)).pipe(
          Effect.map(Option.exists(({ type }) => type === 'Directory')),
        ),

        freeBytes: Effect.tryPromise(() => statfs(dir)).pipe(
          Effect.map(({ bavail, bsize }) => bavail * bsize),
          Effect.orDie,
        ),

        put: Effect.fn('Store.put')(function* ({
          scope,
          name,
          size,
          digest: expectedDigest,
          overwrite,
          retentionDays,
          body,
        }) {
          yield* ensureSubdirectory(tempDir).pipe(Effect.mapError(uploadFailed));
          yield* ensureSubdirectory(artifactsDir).pipe(Effect.mapError(uploadFailed));
          const id = crypto
            .getRandomValues(new Uint8Array(32))
            .toBase64({ alphabet: 'base64url', omitPadding: true });
          const now = yield* currentInstant;
          const expiresAt = now.add({ hours: retentionDays * 24 });
          const temp = path.join(tempDir, id);
          return yield* Effect.acquireUseRelease(
            fs.makeDirectory(temp).pipe(Effect.mapError(uploadFailed)),
            () =>
              Effect.gen(function* () {
                const hash = createHash('sha256');
                yield* body.pipe(
                  countedTo(size),
                  Stream.tap(chunk => Effect.sync(() => hash.update(chunk))),
                  Stream.run(fs.sink(path.join(temp, DATA_FILE))),
                );
                const digest = hash.digest('hex');
                if (expectedDigest !== undefined && digest !== expectedDigest) {
                  return yield* new DigestMismatchError({
                    expected: expectedDigest,
                    actual: digest,
                  });
                }
                const artifact = { ...scope, id, name, size, digest, expiresAt };
                const meta = yield* encodeMeta(artifact).pipe(Effect.orDie);
                yield* fs.writeFileString(path.join(temp, META_FILE), meta);
                // A client gone by now is what a retry is for, so this finishes regardless.
                return yield* publish({ artifact, temp, overwrite }).pipe(Effect.uninterruptible);
              }).pipe(Effect.catchTag('PlatformError', error => Effect.fail(uploadFailed(error)))),
            // A published upload has already moved, so this finds nothing.
            () => removeDirectory(temp),
          );
        }),

        findByName: Effect.fn('Store.findByName')(function* ({ scope, name }) {
          const artifact = yield* readMetaFile(nameFileOf(scope, name));
          if (Option.isNone(artifact) || (yield* isExpired(artifact.value))) return Option.none();
          return artifact;
        }),

        find: Effect.fn('Store.find')(function* (id, name) {
          const meta = yield* readMetaFile(metaFileOf(id));
          if (Option.isNone(meta) || meta.value.id !== id || meta.value.name !== name) {
            return Option.none();
          }
          if (yield* isExpired(meta.value)) return Option.none();
          const named = yield* readMetaFile(nameFileOf(meta.value, name));
          if (!Option.exists(named, current => current.id === id)) return Option.none();
          return Option.some({
            ...meta.value,
            // Counted, as a file cut short by a power cut would otherwise end the response early,
            // short of its Content-Length, and leave the client waiting.
            data: fs
              .stream(path.join(artifactsDir, id, DATA_FILE))
              .pipe(countedTo(meta.value.size)),
          });
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
          },
          { concurrency: 1 },
        ),
      });
    }),
  );
}

/** The sweep at startup and hourly. One that fails is logged, and the next one tries again. */
export const StoreSweeps = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
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
