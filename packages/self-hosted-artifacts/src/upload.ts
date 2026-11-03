import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import {
  ClientError,
  DEFAULT_AUDIENCE,
  makeRunnerTempFile,
  parseBooleanInput,
} from './client-support.ts';
import { findFilesToUpload } from './search.ts';
import { connectToServer, sendToServer } from './server-client.ts';
import { zipFiles } from './zip.ts';

const openFile = Effect.fnUntraced(function* ({ path, name }: { path: string; name: string }) {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = () => new ClientError({ message: `Can't read ${path}` });
  const { size } = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
  const file = yield* Effect.tryPromise({ try: () => openAsBlob(path), catch: unreadable });
  // Node keeps this Blob's size in 32 bits, and fetch would send it as the Content-Length.
  if (file.size !== Number(size)) {
    return yield* new ClientError({
      message: `${name} is ${size} bytes, and Node can't upload 4 GiB or more`,
    });
  }
  return file;
});

/** The SHA-256 of what is sent, streamed. In the client, so a target with no server gets it too. */
const digestFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash('sha256');
  yield* fs.stream(path).pipe(
    Stream.runForEach(chunk => Effect.sync(() => hash.update(chunk))),
    Effect.mapError(() => new ClientError({ message: `Can't read ${path}` })),
  );
  return hash.digest('hex');
});

/** The same in the action's inputs and the command's flags, as actions/upload-artifact has them. */
export const UPLOAD_DEFAULTS = {
  name: 'artifact',
  ifNoFilesFound: 'warn',
  retentionDays: '0',
  compressionLevel: '6',
  includeHiddenFiles: 'false',
  archive: 'true',
  overwrite: 'false',
  audience: DEFAULT_AUDIENCE,
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

const parseRetentionDays = Effect.fnUntraced(function* (value: string) {
  const days = Number.parseInt(value, 10);
  if (Number.isNaN(days)) return yield* new ClientError({ message: 'Invalid retention-days' });
  return days;
});

const parseCompressionLevel = Effect.fnUntraced(function* (value: string) {
  const level = Number.parseInt(value, 10);
  if (Number.isNaN(level)) return yield* new ClientError({ message: 'Invalid compression-level' });
  if (level < 0 || level > 9) {
    return yield* new ClientError({
      message: 'Invalid compression-level. Valid values are 0-9',
    });
  }
  return level;
});

/** In a temp file, as the upload's `Blob` body needs a file; the surrounding scope removes it. */
const zipToTempFile = Effect.fnUntraced(function* ({
  files,
  rootDirectory,
  compressionLevel,
}: {
  files: readonly string[];
  rootDirectory: string;
  compressionLevel: number;
}) {
  const target = yield* makeRunnerTempFile('.zip');
  yield* zipFiles({ files, rootDirectory, compressionLevel, target }).pipe(
    Effect.mapError(({ message }) => new ClientError({ message })),
  );
  return target;
});

export const upload = Effect.fn('upload.upload')(
  function* (inputs: {
    serverUrl: string;
    path: string;
    name: string;
    ifNoFilesFound: string;
    retentionDays: string;
    compressionLevel: string;
    includeHiddenFiles: string;
    archive: string;
    overwrite: string;
    audience: string;
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

    // Before the zip, so a job without the permission finds out without waiting for it.
    const connection = yield* connectToServer({
      serverUrl: inputs.serverUrl,
      audience: inputs.audience,
    });
    const filePath = archive
      ? yield* zipToTempFile({ files, rootDirectory, compressionLevel })
      : firstFile;
    const name = archive ? `${inputs.name}.zip` : basename(firstFile);
    const file = yield* openFile({ path: filePath, name });
    const digest = yield* digestFile(filePath);
    const stored = yield* sendToServer({
      connection,
      file,
      name,
      digest,
      overwrite,
      retentionDays,
    });
    return { _tag: 'Uploaded', name, size: file.size, digest, ...stored } as const;
  },
  // Holds the zip until the last retry is over, and removes it however the upload ends.
  Effect.scoped,
);
