import { statfs } from 'node:fs/promises';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
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

const ArtifactMetaSchema = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
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
    /** Publishes the file and its metadata together: the renamed directory is the only commit. */
    readonly put: (upload: {
      readonly name: string;
      readonly size: number;
      readonly retentionDays: number;
      readonly body: Stream.Stream<Uint8Array, UploadFailedError>;
    }) => Effect.Effect<
      { readonly token: string; readonly expiresAt: Temporal.Instant },
      UploadFailedError
    >;
    /** The artifact only under its exact name, and never once it has expired. */
    readonly find: (
      token: string,
      name: string,
    ) => Effect.Effect<
      Option.Option<
        ArtifactMeta & { readonly data: Stream.Stream<Uint8Array, PlatformError.PlatformError> }
      >
    >;
    /** Removes expired artifacts, directories no artifact can be read from, and dead uploads. */
    readonly sweep: Effect.Effect<{
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

      const currentInstant = Effect.map(
        Clock.currentTimeMillis,
        Temporal.Instant.fromEpochMilliseconds,
      );

      const readMeta = (token: string) =>
        orNoneIfMissing(fs.readFileString(path.join(artifactsDir, token, META_FILE))).pipe(
          Effect.map(Option.flatMap(text => decodeMeta(text))),
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

      const removeEntries = Effect.fnUntraced(function* (
        parent: string,
        shouldRemove: (entry: string) => Effect.Effect<boolean>,
      ) {
        const found = yield* orNoneIfMissing(fs.readDirectory(parent));
        const entries: readonly string[] = Option.getOrElse(found, () => []);
        const removed = yield* Effect.filter(entries, shouldRemove, {
          concurrency: SCANNING_CONCURRENCY,
        });
        yield* Effect.forEach(removed, entry => removeDirectory(path.join(parent, entry)), {
          concurrency: SCANNING_CONCURRENCY,
          discard: true,
        });
        return removed.length;
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

      return Store.of({
        isPresent: orNoneIfMissing(fs.stat(dir)).pipe(
          Effect.map(Option.exists(({ type }) => type === 'Directory')),
        ),

        freeBytes: Effect.tryPromise(() => statfs(dir)).pipe(
          Effect.map(({ bavail, bsize }) => bavail * bsize),
          Effect.orDie,
        ),

        put: Effect.fn('Store.put')(function* ({ name, size, retentionDays, body }) {
          yield* ensureSubdirectory(tempDir).pipe(Effect.mapError(uploadFailed));
          yield* ensureSubdirectory(artifactsDir).pipe(Effect.mapError(uploadFailed));
          const token = crypto
            .getRandomValues(new Uint8Array(32))
            .toBase64({ alphabet: 'base64url', omitPadding: true });
          const now = yield* currentInstant;
          const expiresAt = now.add({ hours: retentionDays * 24 });
          const temp = path.join(tempDir, token);
          yield* Effect.acquireUseRelease(
            fs.makeDirectory(temp).pipe(Effect.mapError(uploadFailed)),
            () =>
              Effect.gen(function* () {
                yield* body.pipe(countedTo(size), Stream.run(fs.sink(path.join(temp, DATA_FILE))));
                const meta = yield* encodeMeta({ name, size, expiresAt }).pipe(Effect.orDie);
                yield* fs.writeFileString(path.join(temp, META_FILE), meta);
                yield* fs.rename(temp, path.join(artifactsDir, token));
              }).pipe(Effect.catchTag('PlatformError', error => Effect.fail(uploadFailed(error)))),
            // A published upload has already moved, so this finds nothing.
            () => removeDirectory(temp),
          );
          return { token, expiresAt };
        }),

        find: Effect.fn('Store.find')(function* (token, name) {
          const meta = yield* readMeta(token);
          if (Option.isNone(meta) || meta.value.name !== name) return Option.none();
          if (yield* isExpired(meta.value)) return Option.none();
          return Option.some({
            ...meta.value,
            data: fs.stream(path.join(artifactsDir, token, DATA_FILE)),
          });
        }),

        sweep: Effect.all({
          removedArtifacts: removeEntries(artifactsDir, token =>
            readMeta(token).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(true),
                  onSome: isExpired,
                }),
              ),
            ),
          ),
          removedTemps: removeEntries(tempDir, isStaleTemp),
        }),
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
