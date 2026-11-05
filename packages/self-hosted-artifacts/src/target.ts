import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import { ClientError } from './client-support.ts';
import { makeS3Target } from './s3-client.ts';
import type { FileToSend } from './sending.ts';
import { makeServerTarget } from './server-client.ts';
import type { ListedArtifact } from './transport.ts';

/** Where artifacts live, as `upload`, `download`, `merge`, `list` and `delete` need it. */
export type Target = {
  /** Fails at once if this job can't use the target, so nothing costly happens first. */
  readonly ready: Effect.Effect<void, ClientError>;
  /** Stores a file under a name, or answers with what the name already holds with this content. */
  readonly send: (upload: {
    readonly file: FileToSend;
    readonly name: string;
    readonly overwrite: boolean;
    /** `0` means the target's default. */
    readonly retentionDays: number;
  }) => Effect.Effect<
    {
      readonly id: string;
      readonly artifactUrl: string;
      readonly links: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    },
    ClientError
  >;
  /** Each name's latest in a run, in name order. An empty repository or run means the job's own. */
  readonly list: (run: {
    readonly repository: string;
    readonly runId: string;
    readonly names?: readonly string[];
    readonly ids?: readonly string[];
  }) => Effect.Effect<readonly ListedArtifact[], ClientError>;
  /** Streams a file to `target`, and answers with the SHA-256 of what came. */
  readonly fetch: (file: {
    readonly artifact: ListedArtifact;
    readonly target: string;
  }) => Effect.Effect<string, ClientError>;
  /** Removes an artifact of the job's own repository, by ID, in any of its runs. */
  readonly remove: (
    id: string,
  ) => Effect.Effect<{ readonly id: string; readonly name: string }, ClientError>;
};

export class ArtifactTarget extends Context.Service<ArtifactTarget, Target>()(
  'self-hosted-artifacts/ArtifactTarget',
) {}

/** The inputs that choose a target, the same in every action and every command. */
export type TargetInputs = {
  readonly serverUrl: string;
  readonly audience: string;
  readonly s3Bucket: string;
  readonly s3Region: string;
  readonly s3Endpoint: string;
  readonly s3LinkBase: string;
  /** `<repository>/<run>/<attempt>`, for a command outside Actions. Only the command has it. */
  readonly scope: string;
};

export const targetLayer = ({
  serverUrl,
  audience,
  s3Bucket,
  s3Region,
  s3Endpoint,
  s3LinkBase,
  scope,
}: TargetInputs): Layer.Layer<
  ArtifactTarget,
  ClientError,
  HttpClient.HttpClient | FileSystem.FileSystem
> =>
  Layer.effect(
    ArtifactTarget,
    Effect.gen(function* () {
      if ((serverUrl === '') === (s3Bucket === '')) {
        return yield* new ClientError({
          message: 'Give exactly one of server-url and s3-bucket',
        });
      }
      if (s3Bucket !== '') {
        return yield* makeS3Target({
          bucket: s3Bucket,
          region: s3Region,
          endpoint: s3Endpoint,
          linkBase: s3LinkBase,
          scope,
        });
      }
      const strays = Object.entries({
        's3-region': s3Region,
        's3-endpoint': s3Endpoint,
        's3-link-base': s3LinkBase,
        scope,
      }).filter(([, value]) => value !== '');
      if (strays.length > 0) {
        const names = strays.map(([name]) => name).join(', ');
        return yield* new ClientError({ message: `${names} only go with s3-bucket` });
      }
      return yield* makeServerTarget({ serverUrl, audience });
    }),
  );
