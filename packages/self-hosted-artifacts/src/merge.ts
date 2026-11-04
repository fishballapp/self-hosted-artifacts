import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import { findArtifacts, type Warn } from './artifacts.ts';
import { ClientError, makeRunnerTempDirectory, parseBooleanInput } from './client-support.ts';
import { placeArtifacts } from './download.ts';
import { FILE_NAME_MESSAGE, isFileName } from './protocol.ts';
import { globEscape } from './search.ts';
import { ArtifactTarget } from './target.ts';
import type { ListedArtifact } from './transport.ts';
import { parseCompressionLevel, parseRetentionDays, UPLOAD_DEFAULTS, upload } from './upload.ts';

const PARALLEL_DELETES = 5;
// A file unpacked here has the time it was unpacked, which would make the same merge a different zip
// each time. The earliest time a zip can hold, so a retried merge comes out the same and the target
// recognises it.
const MERGED_FILES_MODIFIED_AT = new Date(1980, 0, 1);

/** The same in the action's inputs and the command's flags, as actions/upload-artifact/merge has them. */
export const MERGE_DEFAULTS = {
  name: 'merged-artifacts',
  pattern: '*',
  separateDirectories: 'false',
  retentionDays: UPLOAD_DEFAULTS.retentionDays,
  compressionLevel: UPLOAD_DEFAULTS.compressionLevel,
  deleteMerged: 'false',
  includeHiddenFiles: UPLOAD_DEFAULTS.includeHiddenFiles,
} as const;

/** What the merge stored, and which artifacts went into it. */
export type Merged = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly artifactUrl: string;
  readonly links: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  readonly merged: readonly ListedArtifact[];
};

/**
 * Downloads the current run's artifacts that match `pattern`, and uploads them as one, as
 * actions/upload-artifact/merge does. `onMerged` sees the stored artifact before any original is
 * deleted, so a failed delete still leaves the caller its outputs.
 */
export const merge = Effect.fn('merge.merge')(
  function* <E, R>(inputs: {
    name: string;
    pattern: string;
    separateDirectories: string;
    retentionDays: string;
    compressionLevel: string;
    deleteMerged: string;
    includeHiddenFiles: string;
    warn: Warn;
    onMerged: (merged: Merged) => Effect.Effect<void, E, R>;
  }) {
    const { name, pattern, warn } = inputs;
    // All before the first download, as a bad input would otherwise cost every one of them.
    const separateDirectories = yield* parseBooleanInput(
      'separate-directories',
      inputs.separateDirectories,
    );
    const deleteMerged = yield* parseBooleanInput('delete-merged', inputs.deleteMerged);
    const includeHidden = yield* parseBooleanInput(
      'include-hidden-files',
      inputs.includeHiddenFiles,
    );
    yield* parseRetentionDays(inputs.retentionDays);
    yield* parseCompressionLevel(inputs.compressionLevel);
    const storedName = `${name}.zip`;
    if (!isFileName(storedName)) return yield* new ClientError({ message: FILE_NAME_MESSAGE });

    const target = yield* ArtifactTarget;
    yield* target.ready;
    const listed = yield* findArtifacts({
      name: '',
      artifactIds: '',
      pattern,
      repository: '',
      runId: '',
      warn,
    });
    // A re-run's pattern may match the merged artifact of the attempt before: it is not an input,
    // and deleting it would delete the result. A hidden name's folder or file would be left out of
    // the zip, and deleted all the same, so it isn't one either unless hidden files are asked for.
    const artifacts = listed.filter(
      artifact => artifact.name !== storedName && (includeHidden || !artifact.name.startsWith('.')),
    );
    if (artifacts.length === 0) {
      return yield* new ClientError({
        message: `No artifacts found matching pattern '${pattern}'`,
      });
    }

    const directory = yield* makeRunnerTempDirectory();
    const placed = yield* placeArtifacts({
      artifacts,
      root: directory,
      isOneFolder: !separateDirectories,
      skipDecompress: false,
      digestMismatch: 'error',
      warn,
    });
    const mismatched = placed.filter(({ isMismatch }) => isMismatch);
    if (mismatched.length > 0) {
      const names = mismatched.map(({ artifact }) => artifact.name).join(', ');
      return yield* new ClientError({
        message: `Digest validation failed for artifact(s): ${names}. Nothing was merged.`,
      });
    }

    const uploaded = yield* upload({
      // The folder is the path, whatever it holds that a glob would read.
      path: globEscape(directory),
      name,
      ifNoFilesFound: 'ignore',
      retentionDays: inputs.retentionDays,
      compressionLevel: inputs.compressionLevel,
      includeHiddenFiles: inputs.includeHiddenFiles,
      archive: 'true',
      overwrite: 'false',
      zipModifiedAt: MERGED_FILES_MODIFIED_AT,
    });
    if (uploaded._tag === 'NoFilesFound') {
      return yield* new ClientError({
        message: `No files were found in the artifacts matching pattern '${pattern}'. Nothing was merged.`,
      });
    }
    const { id, size, digest, artifactUrl, links, expiresAt } = uploaded;
    yield* inputs.onMerged({
      id,
      name: storedName,
      size,
      digest,
      artifactUrl,
      links,
      expiresAt,
      merged: artifacts,
    });
    yield* Console.error(`The ${artifacts.length} artifact(s) have been successfully merged!`);

    if (!deleteMerged) return;
    const [, failed] = yield* Effect.partition(
      artifacts,
      artifact =>
        target
          .remove(artifact.id)
          .pipe(Effect.mapError(({ message }) => `${artifact.name} (${message})`)),
      { concurrency: PARALLEL_DELETES },
    );
    if (failed.length > 0) {
      return yield* new ClientError({
        message: `Merged into ${storedName}, but couldn't delete: ${failed.join(', ')}`,
      });
    }
    yield* Console.error(`The ${artifacts.length} artifact(s) have been deleted`);
  },
  // Holds the folder of unpacked artifacts until the merged zip is uploaded, and removes it however
  // the step ends.
  Effect.scoped,
);
