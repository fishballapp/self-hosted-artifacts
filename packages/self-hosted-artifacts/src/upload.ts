import { basename } from 'node:path';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { ClientError, makeRunnerTempFile, parseBooleanInput } from './client-support.ts';
import { findFilesToUpload } from './search.ts';
import { openFileToSend } from './sending.ts';
import { ArtifactTarget } from './target.ts';
import { zipFiles } from './zip.ts';

/** The same in the action's inputs and the command's flags, as actions/upload-artifact has them. */
export const UPLOAD_DEFAULTS = {
  name: 'artifact',
  ifNoFilesFound: 'warn',
  retentionDays: '0',
  compressionLevel: '6',
  includeHiddenFiles: 'false',
  archive: 'true',
  overwrite: 'false',
} as const;

const IfNoFilesFoundSchema = Schema.Literals(['warn', 'error', 'ignore']);

const parseIfNoFilesFound = Effect.fnUntraced(function* (value: string) {
  if (!Schema.is(IfNoFilesFoundSchema)(value)) {
    return yield* new ClientError({
      message: `Unrecognized if-no-files-found input. Provided: ${value}. Available options: ${IfNoFilesFoundSchema.literals.join(',')}`,
    });
  }
  return value;
});

export const parseRetentionDays = Effect.fnUntraced(function* (value: string) {
  const days = Number.parseInt(value, 10);
  if (Number.isNaN(days)) return yield* new ClientError({ message: 'Invalid retention-days' });
  return days;
});

export const parseCompressionLevel = Effect.fnUntraced(function* (value: string) {
  const level = Number.parseInt(value, 10);
  if (Number.isNaN(level)) return yield* new ClientError({ message: 'Invalid compression-level' });
  if (level < 0 || level > 9) {
    return yield* new ClientError({
      message: 'Invalid compression-level. Valid values are 0-9',
    });
  }
  return level;
});

/** In a temp file, as an upload reads a file; the surrounding scope removes it. */
const zipToTempFile = Effect.fnUntraced(function* ({
  files,
  rootDirectory,
  compressionLevel,
  modifiedAt,
}: {
  files: readonly string[];
  rootDirectory: string;
  compressionLevel: number;
  modifiedAt?: Date;
}) {
  const target = yield* makeRunnerTempFile('.zip');
  yield* zipFiles({ files, rootDirectory, compressionLevel, modifiedAt, target }).pipe(
    Effect.mapError(({ message }) => new ClientError({ message })),
  );
  return target;
});

export const upload = Effect.fn('upload.upload')(
  function* (inputs: {
    path: string;
    name: string;
    ifNoFilesFound: string;
    retentionDays: string;
    compressionLevel: string;
    includeHiddenFiles: string;
    archive: string;
    overwrite: string;
    /** Stamped on every file in the zip, for a caller whose files' own times mean nothing. */
    zipModifiedAt?: Date;
  }) {
    const includeHiddenFiles = yield* parseBooleanInput(
      'include-hidden-files',
      inputs.includeHiddenFiles,
    );
    const archive = yield* parseBooleanInput('archive', inputs.archive);
    const overwrite = yield* parseBooleanInput('overwrite', inputs.overwrite);
    const ifNoFilesFound = yield* parseIfNoFilesFound(inputs.ifNoFilesFound);
    const retentionDays = yield* parseRetentionDays(inputs.retentionDays);
    const compressionLevel = yield* parseCompressionLevel(inputs.compressionLevel);

    const { files, rootDirectory } = yield* findFilesToUpload({
      searchPath: inputs.path,
      includeHiddenFiles,
    }).pipe(Effect.mapError(({ message }) => new ClientError({ message })));

    const [firstFile] = files;
    if (firstFile === undefined) {
      const message = `No files were found with the provided path: ${inputs.path}. No artifacts will be uploaded.`;
      if (ifNoFilesFound === 'error') return yield* new ClientError({ message });
      return { _tag: 'NoFilesFound', message, isWarning: ifNoFilesFound === 'warn' } as const;
    }
    yield* Console.error(
      `With the provided path, there will be ${files.length} file${files.length === 1 ? '' : 's'} uploaded`,
    );
    if (!archive && files.length > 1) {
      return yield* new ClientError({
        message: `When 'archive' is set to false, only a single file can be uploaded. Found ${files.length} files to upload.`,
      });
    }

    // Before the zip, so a job that can't use the target finds out without waiting for it.
    const target = yield* ArtifactTarget;
    yield* target.ready;
    const filePath = archive
      ? yield* zipToTempFile({
          files,
          rootDirectory,
          compressionLevel,
          modifiedAt: inputs.zipModifiedAt,
        })
      : firstFile;
    const name = archive ? `${inputs.name}.zip` : basename(firstFile);
    const file = yield* openFileToSend(filePath);
    const stored = yield* target.send({ file, name, overwrite, retentionDays });
    return { _tag: 'Uploaded', name, size: file.size, digest: file.digest, ...stored } as const;
  },
  // Holds the zip until the last retry is over, and removes it however the upload ends.
  Effect.scoped,
);
