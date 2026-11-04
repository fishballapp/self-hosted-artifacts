import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import {
  artifactNameOf,
  findArtifacts,
  noteGithubTokenIgnored,
  parseRun,
  type Warn,
} from './artifacts.ts';
import { ClientError, makeRunnerTempFile, parseBooleanInput } from './client-support.ts';
import { ArtifactTarget } from './target.ts';
import type { ListedArtifact } from './transport.ts';
import { directoriesBelow, extractZip } from './unzip.ts';

const PARALLEL_DOWNLOADS = 5;
const DOWNLOADED_FILE_MODE = 0o644;

/** The same in the action's inputs and the command's flags, as actions/download-artifact has them. */
export const DOWNLOAD_DEFAULTS = {
  mergeMultiple: 'false',
  skipDecompress: 'false',
  digestMismatch: 'error',
} as const;

const DigestMismatchSchema = Schema.Literals(['ignore', 'info', 'warn', 'error']);
export type DigestMismatch = typeof DigestMismatchSchema.Type;

const parseDigestMismatch = Effect.fnUntraced(function* (value: string) {
  if (!Schema.is(DigestMismatchSchema)(value)) {
    return yield* new ClientError({
      message: `Invalid value for 'digest-mismatch': '${value}'. Valid options are: ${DigestMismatchSchema.literals.join(', ')}`,
    });
  }
  return value;
});

const resolveDestination = Effect.fnUntraced(function* (path: string) {
  const workspace = yield* Config.String('GITHUB_WORKSPACE').pipe(
    Config.withDefault(''),
    Effect.catchTag('ConfigError', Effect.die),
  );
  // A line break would end the `download-path` output early, and start another.
  if (/[\r\n]/u.test(path)) return yield* new ClientError({ message: 'path has a line break' });
  const chosen = path === '' ? workspace : path;
  return resolve(chosen.startsWith('~') ? chosen.replace('~', homedir()) : chosen);
});

const directoryBelow = (root: string, segments: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const ensureDirectories = await directoriesBelow(root);
      await ensureDirectories(segments);
      return join(root, ...segments);
    },
    catch: cause =>
      new ClientError({ message: Predicate.isError(cause) ? cause.message : String(cause) }),
  });

/** `RUNNER_TEMP` may be another disk, where only a copy works. Replaces what's there, never follows it. */
const moveInto = Effect.fnUntraced(function* ({ temp, target }: { temp: string; target: string }) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, { force: true });
  yield* fs.rename(temp, target).pipe(Effect.catch(() => fs.copyFile(temp, target)));
  yield* fs.chmod(target, DOWNLOADED_FILE_MODE);
});

/** Fetches one artifact to a temp file, checks it, and only then unpacks or moves it. */
const fetchAndPlace = Effect.fnUntraced(
  function* ({
    artifact,
    root,
    subdirectory,
    skipDecompress,
    digestMismatch,
    warn,
  }: {
    artifact: ListedArtifact;
    root: string;
    subdirectory: readonly string[];
    skipDecompress: boolean;
    digestMismatch: DigestMismatch;
    warn: Warn;
  }) {
    const temp = yield* makeRunnerTempFile('.download');
    const digest = yield* (yield* ArtifactTarget).fetch({ artifact, target: temp });
    const isMismatch = digest !== artifact.digest;
    if (isMismatch && digestMismatch === 'error') return { isMismatch };
    if (isMismatch) {
      // Before unpacking, which is what a bad zip may well fail at.
      const message = `Artifact '${artifact.name}' digest validation failed. Please verify the integrity of the artifact.`;
      if (digestMismatch === 'info') yield* Console.error(message);
      if (digestMismatch === 'warn') yield* warn(message);
    }

    const destination = yield* directoryBelow(root, subdirectory);
    const failed = (reason: string) =>
      new ClientError({ message: `Can't place ${artifact.name} in ${destination}: ${reason}` });
    if (!skipDecompress && /\.zip$/iu.test(artifact.name)) {
      yield* extractZip({ zip: temp, destination }).pipe(
        Effect.mapError(({ message }) => failed(message)),
      );
      return { isMismatch };
    }
    yield* moveInto({ temp, target: join(destination, artifact.name) }).pipe(
      Effect.mapError(({ message }) => failed(message)),
    );
    return { isMismatch };
  },
  // Holds the temp file until it's unpacked, and removes it however this ends.
  Effect.scoped,
);

/**
 * Fetches each artifact below `root`, into a folder of its name or all into `root` itself, and says
 * which didn't match the digest stored with them.
 */
export const placeArtifacts = Effect.fnUntraced(function* ({
  artifacts,
  root,
  isOneFolder,
  skipDecompress,
  digestMismatch,
  warn,
}: {
  artifacts: readonly ListedArtifact[];
  root: string;
  isOneFolder: boolean;
  skipDecompress: boolean;
  digestMismatch: DigestMismatch;
  warn: Warn;
}) {
  if (artifacts.length > 0) {
    yield* Console.error('Preparing to download the following artifacts:');
    yield* Effect.forEach(
      artifacts,
      ({ name, id, size, digest }) =>
        Console.error(`- ${name} (ID: ${id}, Size: ${size}, Expected Digest: ${digest})`),
      { concurrency: 1, discard: true },
    );
  }

  // As a disk may fold them: `Build.zip` and `build.zip` are two artifacts, one folder, and so are
  // the two ways to write `café`.
  const isSharingFolders =
    isOneFolder ||
    new Set(artifacts.map(artifact => artifactNameOf(artifact).normalize('NFC').toLowerCase()))
      .size < artifacts.length;
  return yield* Effect.forEach(
    artifacts,
    Effect.fnUntraced(function* (artifact) {
      const { isMismatch } = yield* fetchAndPlace({
        artifact,
        root,
        subdirectory: isOneFolder ? [] : [artifactNameOf(artifact)],
        skipDecompress,
        digestMismatch,
        warn,
      });
      return { artifact, isMismatch };
    }),
    // In order when they share a folder, so the last one wins a path they both hold, every time.
    { concurrency: isSharingFolders ? 1 : PARALLEL_DOWNLOADS },
  );
});

export const download = Effect.fn('download.download')(function* (inputs: {
  name: string;
  artifactIds: string;
  path: string;
  pattern: string;
  mergeMultiple: string;
  isGithubTokenGiven: boolean;
  repository: string;
  runId: string;
  skipDecompress: string;
  digestMismatch: string;
  warn: Warn;
}) {
  const { warn } = inputs;
  const digestMismatch = yield* parseDigestMismatch(inputs.digestMismatch);
  const mergeMultiple = yield* parseBooleanInput('merge-multiple', inputs.mergeMultiple);
  const skipDecompress = yield* parseBooleanInput('skip-decompress', inputs.skipDecompress);
  const { repository, runId } = yield* parseRun(inputs);
  const downloadPath = yield* resolveDestination(inputs.path);
  if (inputs.isGithubTokenGiven) yield* noteGithubTokenIgnored;

  yield* (yield* ArtifactTarget).ready;
  const artifacts = yield* findArtifacts({
    name: inputs.name,
    artifactIds: inputs.artifactIds,
    pattern: inputs.pattern,
    repository,
    runId,
    warn,
  });

  const isOneFolder = inputs.name !== '' || mergeMultiple || artifacts.length === 1;
  const placed = yield* placeArtifacts({
    artifacts,
    root: downloadPath,
    isOneFolder,
    skipDecompress,
    digestMismatch,
    warn,
  });

  const mismatched = placed.filter(({ isMismatch }) => isMismatch);
  if (mismatched.length > 0 && digestMismatch === 'error') {
    const names = mismatched.map(({ artifact }) => artifact.name).join(', ');
    return yield* new ClientError({
      message: `Digest validation failed for artifact(s): ${names}. Use 'digest-mismatch: warn' to continue on mismatch.`,
    });
  }
  return { downloadPath, artifacts };
});
