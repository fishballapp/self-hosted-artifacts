import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rm, stat, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as Effect from 'effect/Effect';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import { type Entry, openPromise } from 'yauzl';

/** Why a zip wasn't unpacked. */
export class UnzipError extends Schema.TaggedError<UnzipError>()('UnzipError', {
  message: Schema.String,
}) {}

const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;
const PERMISSIONS_MASK = 0o777;
const DEFAULT_FILE_MODE = 0o666;

/** Only a zip made on these holds a Unix mode there: Windows keeps its own attributes in those bits. */
const UNIX_CREATORS = new Set([3, 19]);

const unixModeOf = ({ versionMadeBy, externalFileAttributes }: Entry) =>
  UNIX_CREATORS.has(versionMadeBy >>> 8) ? externalFileAttributes >>> 16 : 0;

const isInside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/**
 * Whether a folder is at `directory`, refusing a symlink out of `root`, or something that isn't a
 * folder: `root` itself may be a symlink, and so may what a workspace already holds.
 */
const isExistingDirectory = async ({
  root,
  realRoot,
  directory,
}: {
  root: string;
  realRoot: string;
  directory: string;
}) => {
  const stats = await lstat(directory).catch(() => undefined);
  if (stats === undefined) return false;
  if (stats.isSymbolicLink() && !isInside(realRoot, await realpath(directory))) {
    throw new Error(`${relative(root, directory)} is a symlink leading out of ${root}`);
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`${relative(root, directory)} is in the way of a folder`);
  }
  return true;
};

/** A function that creates a path of directories below `root`, as `isExistingDirectory` allows. */
export const directoriesBelow = async (root: string) => {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const checked = new Set<string>();
  return async (segments: readonly string[]) => {
    for (const depth of segments.keys()) {
      const directory = join(root, ...segments.slice(0, depth + 1));
      if (checked.has(directory)) continue;
      // Its parents are checked by now. Artifacts unpacking side by side can share a folder.
      if (!(await isExistingDirectory({ root, realRoot, directory }))) {
        await mkdir(directory, { recursive: true });
      }
      checked.add(directory);
    }
  };
};

const directorySegmentsOf = (entry: Entry, segments: readonly string[]) =>
  entry.fileName.endsWith('/') ? segments : segments.slice(0, -1);

/**
 * An entry's path as segments that can only stay below where they're joined. yauzl refuses absolute
 * paths, `..` and backslashes as it reads each name, and this holds whether or not it goes on to.
 */
const segmentsOf = ({ fileName }: Entry) => {
  const segments = fileName.split('/').filter(segment => segment !== '' && segment !== '.');
  const isUnsafe =
    fileName.startsWith('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    segments.includes('..') ||
    (segments.length === 0 && !fileName.endsWith('/'));
  if (isUnsafe) throw new Error(`${JSON.stringify(fileName)} leads out of the destination`);
  return segments;
};

/**
 * Checks every entry, and what the destination already holds on its way, writing nothing, and sums
 * what the entries declare, which yauzl holds each entry's stream to.
 */
const inspect = async (zipPath: string, destination: string) => {
  const zip = await openPromise(zipPath);
  const realRoot = await realpath(destination);
  const checked = new Set<string>();
  let declaredBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const segments = segmentsOf(entry);
      const directories = directorySegmentsOf(entry, segments);
      for (const depth of directories.keys()) {
        const directory = join(destination, ...directories.slice(0, depth + 1));
        if (checked.has(directory)) continue;
        checked.add(directory);
        const isThere = await isExistingDirectory({ root: destination, realRoot, directory });
        // Nothing below a folder that isn't there yet can be in the way.
        if (!isThere) break;
      }
      // Inside or out: a link inside could be chained to lead out, and upload never writes one.
      if ((unixModeOf(entry) & FILE_TYPE_MASK) === SYMLINK_TYPE) {
        throw new Error(`${JSON.stringify(entry.fileName)} is a symlink`);
      }
      declaredBytes += entry.uncompressedSize;
    }
  } finally {
    zip.close();
  }
  return declaredBytes;
};

const write = async ({
  zipPath,
  destination,
  ensureDirectories,
  signal,
}: {
  zipPath: string;
  destination: string;
  ensureDirectories: (segments: readonly string[]) => Promise<void>;
  signal: AbortSignal;
}) => {
  const zip = await openPromise(zipPath);
  try {
    for await (const entry of zip.eachEntry()) {
      const segments = segmentsOf(entry);
      await ensureDirectories(directorySegmentsOf(entry, segments));
      if (entry.fileName.endsWith('/')) continue;
      const target = join(destination, ...segments);
      // Replaced, not opened: `wx` would never follow a symlink that is already there.
      await rm(target, { force: true });
      const mode = unixModeOf(entry) & PERMISSIONS_MASK;
      await pipeline(
        await zip.openReadStreamPromise(entry),
        createWriteStream(target, { flags: 'wx', mode: mode || DEFAULT_FILE_MODE }),
        { signal },
      );
      // After the writing, as a mode given on creation is cut down by the runner's umask.
      if (mode !== 0) await chmod(target, mode);
    }
  } finally {
    zip.close();
  }
};

/**
 * Unpacks a zip below `destination`, entry by entry. It looks at every entry first, so one it refuses
 * writes nothing, and what the entries declare has to fit on the disk, so a zip bomb can't fill it.
 */
export const extractZip = Effect.fn('unzip.extractZip')(function* ({
  zip,
  destination,
}: {
  zip: string;
  destination: string;
}) {
  yield* Effect.tryPromise({
    try: async signal => {
      const ensureDirectories = await directoriesBelow(destination);
      const declaredBytes = await inspect(zip, destination);
      const { bavail, bsize } = await statfs(destination);
      if (declaredBytes > bavail * bsize) {
        throw new Error(
          `it would unpack to ${declaredBytes} bytes, with ${bavail * bsize} free in ${destination}`,
        );
      }
      await write({ zipPath: zip, destination, ensureDirectories, signal });
    },
    catch: cause =>
      new UnzipError({ message: Predicate.isError(cause) ? cause.message : String(cause) }),
  });
});
