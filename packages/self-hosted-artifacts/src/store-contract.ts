import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import type * as Option from 'effect/Option';
import type * as PlatformError from 'effect/PlatformError';
import * as Schema from 'effect/Schema';
import type * as Stream from 'effect/Stream';

// What the routes need of where artifacts are. The routes run on a Worker too, so this file, like
// `server.ts`, imports nothing of Node's and doesn't touch `Temporal`.

/** A number GitHub assigned. Digits only, as these become directories. */
export const RunNumberSchema = Schema.String.check(Schema.isPattern(/^[0-9]+$/u));

/** Where a name means one artifact. Comes from a verified token, never from the request. */
export type RunScope = {
  readonly repositoryId: string;
  readonly runId: string;
  readonly runAttempt: string;
};

export const ArtifactMetaSchema = Schema.Struct({
  id: Schema.String,
  repositoryId: RunNumberSchema,
  runId: RunNumberSchema,
  runAttempt: RunNumberSchema,
  name: Schema.String,
  size: Schema.Finite,
  digest: Schema.String,
  expiresAt: Schema.String.check(
    Schema.makeFilter(text => !Number.isNaN(Date.parse(text)), { message: 'an instant' }),
  ),
});
export type ArtifactMeta = typeof ArtifactMetaSchema.Type;

/** What a job says it is about to upload, at the start and again at the commit. */
export type UploadDeclaration = {
  readonly scope: RunScope;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly overwrite: boolean;
  readonly retentionDays: number;
};

/**
 * Where the body goes. `url` and `uploadId` are credentials: they must never reach a log or an error's
 * message.
 */
export type UploadTarget =
  | {
      readonly kind: 'single';
      readonly id: string;
      /** A path on this server, or an absolute URL when the body goes elsewhere. */
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'multipart';
      readonly id: string;
      /** The bucket's, which the client echoes, as a server holds no state between requests. */
      readonly uploadId: string;
      readonly partSize: number;
    };

/** A part a client is about to send: what S3 holds it to is signed into its URL. */
export type PartToSign = { readonly partNumber: number; readonly md5: string };

/** `url` is a credential, like an upload's. */
export type SignedPart = {
  readonly partNumber: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** A part the bucket holds, and the ETag it answered with. */
export type SentPart = { readonly partNumber: number; readonly etag: string };

/** An upload in parts, by what names it in the bucket. */
export type MultipartUpload = {
  readonly id: string;
  readonly name: string;
  readonly uploadId: string;
};

/** An upload that didn't become an artifact. `reason` is safe to log: it holds no path. */
export class UploadFailedError extends Schema.TaggedError<UploadFailedError>()(
  'UploadFailedError',
  { reason: Schema.String },
) {}

/** The file wouldn't leave the store the room it's meant to keep. */
export class NotEnoughSpaceError extends Schema.TaggedError<NotEnoughSpaceError>()(
  'NotEnoughSpaceError',
  {},
) {}

/** No body is there to commit, for this declaration and this run. */
export class UploadNotFoundError extends Schema.TaggedError<UploadNotFoundError>()(
  'UploadNotFoundError',
  {},
) {}

/** The scope already holds this name, with other content, and the upload didn't ask to replace it. */
export class ArtifactExistsError extends Schema.TaggedError<ArtifactExistsError>()(
  'ArtifactExistsError',
  {},
) {}

/** There is no such artifact, or its name no longer refers to it, so nothing can be removed. */
export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
  'ArtifactNotFoundError',
  {},
) {}

/** The artifact exists, in a repository other than the one asking to remove it. */
export class OtherRepositoryError extends Schema.TaggedError<OtherRepositoryError>()(
  'OtherRepositoryError',
  {},
) {}

/** How a link is answered. */
export type Download =
  | { readonly _tag: 'NotFound' }
  | {
      readonly _tag: 'Stream';
      readonly size: number;
      readonly data: Stream.Stream<Uint8Array, PlatformError.PlatformError | UploadFailedError>;
    }
  | {
      readonly _tag: 'Redirect';
      readonly size: number;
      /** Holds a signature: it must never reach a log. */
      readonly location: string;
    };

export type StoreShape = {
  readonly isPresent: Effect.Effect<boolean>;
  /** Makes somewhere for a declared upload's body to go. */
  readonly create: (upload: UploadDeclaration) => Effect.Effect<UploadTarget, NotEnoughSpaceError>;
  /** Signs URLs for parts of an upload, asking nothing of the bucket. A disk takes no parts. */
  readonly signParts: (
    upload: MultipartUpload & { readonly size: number; readonly parts: readonly PartToSign[] },
  ) => Effect.Effect<readonly SignedPart[], UploadNotFoundError>;
  /** Stops an upload in parts, best-effort. A disk takes no parts. */
  readonly abort: (upload: MultipartUpload) => Effect.Effect<void, UploadNotFoundError>;
  /**
   * Publishes an uploaded body under its name, which is the only commit. `isNew` is false when the
   * scope already held the same content, this upload's included: the answer is then that artifact,
   * unchanged.
   */
  readonly commit: (
    upload: UploadDeclaration & {
      readonly id: string;
      readonly repository: string;
      /** What finishes an upload in parts first. */
      readonly multipart?: {
        readonly uploadId: string;
        readonly parts: readonly SentPart[];
      };
    },
  ) => Effect.Effect<
    { readonly artifact: ArtifactMeta; readonly isNew: boolean },
    UploadNotFoundError | ArtifactExistsError
  >;
  /** What a name in a scope refers to now, unless that has expired. */
  readonly findByName: (named: {
    readonly scope: RunScope;
    readonly name: string;
  }) => Effect.Effect<Option.Option<ArtifactMeta>>;
  /** A repository's ID from its `owner/name`, once it has uploaded, whatever the case. */
  readonly findRepository: (name: string) => Effect.Effect<Option.Option<string>>;
  /** Each name in a run, or only those given, from the latest attempt that holds it, in name order. */
  readonly listLatest: (run: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly names?: readonly string[];
  }) => Effect.Effect<readonly ArtifactMeta[]>;
  /** Takes an artifact's name away, which is the commit, then removes its files. */
  readonly remove: (artifact: {
    readonly id: string;
    readonly repositoryId: string;
  }) => Effect.Effect<ArtifactMeta, ArtifactNotFoundError | OtherRepositoryError>;
  /**
   * The artifact only under its exact ID and name, while its name still refers to it, and never
   * once it has expired.
   */
  readonly findDownload: (id: string, name: string) => Effect.Effect<Download>;
};

export class Store extends Context.Service<Store, StoreShape>()('self-hosted-artifacts/Store') {}
