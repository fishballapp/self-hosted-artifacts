import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Also the server's requestTimeout: enough for 2 GiB at about 5 Mbit/s. */
export const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
// Node enforces requestTimeout on a 30-second tick, so an upload can outlive it by that much.
const STALE_TEMP_MS = UPLOAD_TIMEOUT_MS + 60 * 1000;

const DATA_FILE = 'data';
const META_FILE = 'meta.json';

export type ArtifactMeta = { name: string; size: number; expiresAt: Temporal.Instant };

export type Store = ReturnType<typeof createStore>;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const ignoreNotFound = (error: unknown): undefined => {
  if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
  throw error;
};

const parseMeta = (text: string): ArtifactMeta | undefined => {
  try {
    const { name, size, expiresAt }: { [key: string]: unknown } = JSON.parse(text);
    if (typeof name !== 'string' || typeof size !== 'number' || typeof expiresAt !== 'string') {
      return undefined;
    }
    return { name, size, expiresAt: Temporal.Instant.from(expiresAt) };
  } catch {
    return undefined;
  }
};

/**
 * The store's directories are created one level at a time, and never `recursive`: with STORE_DIR
 * missing that would create it, and a directory at a volume's mount path sends the real disk
 * elsewhere when it mounts.
 */
const ensureSubdirectory = async (path: string) => {
  await mkdir(path).catch((error: unknown) => {
    if (errorCode(error) !== 'EEXIST') throw error;
  });
};

const removeDirectory = (path: string) => rm(path, { recursive: true, force: true });

const countedTo = (expectedSize: number) =>
  async function* (source: AsyncIterable<Uint8Array>) {
    let received = 0;
    for await (const chunk of source) {
      received += chunk.length;
      if (received > expectedSize) throw new Error('body is longer than its Content-Length');
      yield chunk;
    }
    if (received !== expectedSize) throw new Error('body is shorter than its Content-Length');
  };

export const createStore = ({ dir, now }: { dir: string; now: () => Temporal.Instant }) => {
  const tempDir = join(dir, 'tmp');
  const artifactsDir = join(dir, 'artifacts');

  const readMeta = async (token: string): Promise<ArtifactMeta | undefined> => {
    const text = await readFile(join(artifactsDir, token, META_FILE), 'utf8').catch(ignoreNotFound);
    return text === undefined ? undefined : parseMeta(text);
  };

  const isExpired = ({ expiresAt }: ArtifactMeta) =>
    Temporal.Instant.compare(now(), expiresAt) >= 0;

  const removeEntries = async (
    parent: string,
    shouldRemove: (entry: string) => Promise<boolean>,
  ): Promise<number> => {
    const entries = (await readdir(parent).catch(ignoreNotFound)) ?? [];
    const decisions = await Promise.all(entries.map(shouldRemove));
    const removed = entries.filter((_, index) => decisions[index]);
    await Promise.all(removed.map(entry => removeDirectory(join(parent, entry))));
    return removed.length;
  };

  return {
    isPresent: async (): Promise<boolean> => {
      const stats = await stat(dir).catch(ignoreNotFound);
      return stats?.isDirectory() ?? false;
    },

    freeBytes: async (): Promise<number> => {
      const { bavail, bsize } = await statfs(dir);
      return bavail * bsize;
    },

    /** Publishes the file and its metadata together: the renamed directory is the only commit. */
    put: async ({
      name,
      size,
      retentionDays,
      body,
    }: {
      name: string;
      size: number;
      retentionDays: number;
      body: Readable;
    }): Promise<{ token: string; expiresAt: Temporal.Instant }> => {
      await ensureSubdirectory(tempDir);
      await ensureSubdirectory(artifactsDir);
      const token = crypto
        .getRandomValues(new Uint8Array(32))
        .toBase64({ alphabet: 'base64url', omitPadding: true });
      const expiresAt = now().add({ hours: retentionDays * 24 });
      const temp = join(tempDir, token);
      await mkdir(temp);
      try {
        await pipeline(body, countedTo(size), createWriteStream(join(temp, DATA_FILE)));
        await writeFile(join(temp, META_FILE), JSON.stringify({ name, size, expiresAt }));
        await rename(temp, join(artifactsDir, token));
      } catch (error) {
        await removeDirectory(temp);
        throw error;
      }
      return { token, expiresAt };
    },

    /** The artifact only under its exact name, and never once it has expired. */
    find: async (token: string, name: string) => {
      const meta = await readMeta(token);
      if (meta === undefined || meta.name !== name || isExpired(meta)) return undefined;
      return { ...meta, dataPath: join(artifactsDir, token, DATA_FILE) };
    },

    /** Removes expired artifacts, directories no artifact can be read from, and dead uploads. */
    sweep: async (): Promise<{ removedArtifacts: number; removedTemps: number }> => ({
      removedArtifacts: await removeEntries(artifactsDir, async token => {
        const meta = await readMeta(token);
        return meta === undefined || isExpired(meta);
      }),
      // A temp's directory is touched when the upload starts and when it ends, not while it writes,
      // so this holds any upload the request timeout hasn't yet ended.
      removedTemps: await removeEntries(tempDir, async temp => {
        const stats = await stat(join(tempDir, temp)).catch(ignoreNotFound);
        return stats !== undefined && now().epochMilliseconds - stats.mtimeMs > STALE_TEMP_MS;
      }),
    }),
  };
};
