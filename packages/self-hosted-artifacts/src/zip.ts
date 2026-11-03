import { createWriteStream } from 'node:fs';
import { relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as Effect from 'effect/Effect';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { ZipFile } from 'yazl';

/** Why the files couldn't be zipped. */
export class ZipError extends Schema.TaggedError<ZipError>()('ZipError', {
  message: Schema.String,
}) {}

const INVALID_PATH_CHARACTERS = new Map([
  ['"', ' Double quote "'],
  [':', ' Colon :'],
  ['<', ' Less than <'],
  ['>', ' Greater than >'],
  ['|', ' Vertical bar |'],
  ['*', ' Asterisk *'],
  ['?', ' Question mark ?'],
  ['\r', ' Carriage return \\r'],
  ['\n', ' Line feed \\n'],
]);

/** Refused as actions/upload-artifact refuses them, since NTFS can't unpack such a name. */
const validateEntryName = (name: string): Result.Result<void, ZipError> => {
  const invalid = [...INVALID_PATH_CHARACTERS.entries()].find(([character]) =>
    name.includes(character),
  );
  if (invalid === undefined) return Result.void;
  return Result.fail(
    new ZipError({
      message: `The path for one of the files in artifact is not valid: ${name}. Contains the following character: ${invalid[1]}

Invalid characters include: ${[...INVALID_PATH_CHARACTERS.values()].join(',')}

The following characters are not allowed in files that are uploaded due to limitations with certain file systems such as NTFS. To maintain file system agnostic behavior, these characters are intentionally not allowed to prevent potential problems with downloads on different file systems.`,
    }),
  );
};

/** An aborted pipeline fails with an AbortError holding the real failure as its cause. */
const describeAbortableCause = (cause: unknown) => {
  const reason = Predicate.hasProperty(cause, 'cause') ? cause.cause : cause;
  return Predicate.isError(reason) ? reason.message : String(reason);
};

/**
 * Streams `files` into a zip at `target`, each named by its path below `rootDirectory`. Each entry
 * has its file's modified time, or `modifiedAt` when given, which makes the same files the same zip.
 */
export const zipFiles = Effect.fn('zip.zipFiles')(function* ({
  files,
  rootDirectory,
  compressionLevel,
  modifiedAt,
  target,
}: {
  files: readonly string[];
  rootDirectory: string;
  compressionLevel: number;
  modifiedAt?: Date;
  target: string;
}) {
  const entries = files.map(file => ({ file, name: relative(rootDirectory, file) }));
  yield* Effect.fromResult(Result.all(entries.map(({ name }) => validateEntryName(name))));
  yield* Effect.tryPromise({
    try: signal => {
      const zip = new ZipFile();
      const unreadable = new AbortController();
      zip.on('error', cause => unreadable.abort(cause));
      for (const { file, name } of entries) {
        zip.addFile(file, name, {
          compressionLevel,
          ...(modifiedAt === undefined ? {} : { mtime: modifiedAt }),
        });
      }
      zip.end();
      return pipeline(zip.outputStream, createWriteStream(target), {
        signal: AbortSignal.any([signal, unreadable.signal]),
      });
    },
    catch: cause =>
      new ZipError({ message: `Can't zip the files: ${describeAbortableCause(cause)}` }),
  });
});
