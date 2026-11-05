import { createHash } from 'node:crypto';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTS_PER_SIGNING, partLengthOf, partSizeOf } from './protocol.ts';
import { type FileToSend, openFileToSend, sendParts } from './sending.ts';
import type { PartToSign } from './store-contract.ts';
import { clockAt } from './test-support.ts';

vi.mock('./protocol.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./protocol.ts')>()),
  // TEST_MULTIPART_FROM_BYTES, which a hoisted mock can't import.
  MULTIPART_FROM_BYTES: 32 * 1024 ** 2,
}));

const MIB = 1024 ** 2;

describe('reading a file to send', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-sending-'));
  });

  afterEach(() => rm(directory, { recursive: true, force: true }));

  const read = (path: string) =>
    Effect.runPromise(openFileToSend(path).pipe(Effect.provide(NodeFileSystem.layer)));

  const md5Of = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('base64');

  it('hashes each part, across where a read happens to stop, in one pass with the whole', async () => {
    const path = join(directory, 'big.bin');
    const parts = [
      Buffer.alloc(partSizeOf(40 * MIB), 1),
      Buffer.alloc(partSizeOf(40 * MIB), 2),
      Buffer.alloc(8 * MIB, 3),
    ];
    await writeFile(path, Buffer.concat(parts));

    const file = await read(path);

    expect(file.size).toBe(40 * MIB);
    expect(file.partMd5s).toEqual(parts.map(md5Of));
    expect(file.digest).toBe(createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
  });

  it('hashes no parts of what goes whole', async () => {
    const path = join(directory, 'small.bin');
    await writeFile(path, 'x');
    const file = await read(path);
    expect(file.partMd5s).toEqual([]);
    expect(file.digest).toBe(createHash('sha256').update('x').digest('hex'));
  });

  it('reads a part where it is in the file', async () => {
    const path = join(directory, 'big.bin');
    await writeFile(path, Buffer.concat([Buffer.alloc(16 * MIB, 1), Buffer.alloc(24 * MIB, 2)]));
    const file = await read(path);
    const bytes = await Effect.runPromise(file.readPart(3, new Uint8Array(16 * MIB)));
    expect(bytes.length).toBe(8 * MIB);
    expect(new Set(bytes)).toEqual(new Set([2]));
  });

  it('says so of a file that has shrunk by the time its part is read', async () => {
    const path = join(directory, 'big.bin');
    await writeFile(path, '');
    await truncate(path, 40 * MIB);
    const file = await read(path);
    await truncate(path, 20 * MIB);
    await expect(Effect.runPromise(file.readPart(3, new Uint8Array(16 * MIB)))).rejects.toThrow(
      /changed while it was being sent/u,
    );
  });

  it('says so of a file that has grown by the time its part is read', async () => {
    const path = join(directory, 'big.bin');
    await writeFile(path, '');
    await truncate(path, 40 * MIB);
    const file = await read(path);
    await truncate(path, 41 * MIB);
    await expect(Effect.runPromise(file.readPart(1, new Uint8Array(16 * MIB)))).rejects.toThrow(
      /changed while it was being sent/u,
    );
  });
});

describe('sending parts', () => {
  const fileOf = (parts: number): FileToSend => {
    const size = partSizeOf(MIB) * (parts - 1) + 1;
    return {
      size,
      digest: 'a'.repeat(64),
      partMd5s: Array.from({ length: parts }, (_, index) => `md5-${index + 1}`),
      wholeBody: () => {
        throw new Error('A part is not the whole');
      },
      readPart: (partNumber, into) =>
        Effect.succeed(into.subarray(0, partLengthOf(size, partNumber))),
    };
  };

  const send = async (
    file: FileToSend,
    { onPut = () => undefined }: { onPut?: (url: string) => void } = {},
    now: { instant: Temporal.Instant } = { instant: Temporal.Now.instant() },
  ) => {
    const signings: (readonly PartToSign[])[] = [];
    const puts: string[] = [];
    const sent = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* sendParts({
          client,
          file,
          sign: parts =>
            Effect.sync(() => {
              signings.push(parts);
              return parts.map(({ partNumber, md5 }) => ({
                partNumber,
                url: `http://bucket.test/${partNumber}?signing=${signings.length}`,
                headers: { 'content-md5': md5 },
              }));
            }),
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer.pipe(
              Layer.provide(
                Layer.succeed(FetchHttpClient.Fetch, async input => {
                  const url = String(input);
                  puts.push(url);
                  onPut(url);
                  return new Response(null, {
                    headers: { etag: `"${new URL(url).pathname.slice(1)}"` },
                  });
                }),
              ),
            ),
            Layer.succeed(HttpClient.TracerPropagationEnabled, false),
            clockAt(() => now.instant),
          ),
        ),
      ),
    );
    return { signings, puts, sent };
  };

  it('asks for URLs a batch at a time, and answers in part order', async () => {
    const parts = PARTS_PER_SIGNING + 1;
    const { signings, sent } = await send(fileOf(parts));
    expect(signings.map(batch => batch.length)).toEqual([PARTS_PER_SIGNING, 1]);
    expect(sent.map(({ partNumber }) => partNumber)).toEqual(
      Array.from({ length: parts }, (_, index) => index + 1),
    );
    expect(sent[0]?.etag).toBe('"1"');
  });

  it('signs a part again once its batch is old, rather than send it on a URL about to expire', async () => {
    const now = { instant: Temporal.Now.instant() };
    const { signings, puts } = await send(
      fileOf(8),
      {
        onPut: () => {
          now.instant = now.instant.add({ minutes: 46 });
        },
      },
      now,
    );
    expect(signings[0]).toHaveLength(8);
    expect(signings.slice(1).every(batch => batch.length === 1)).toBe(true);
    expect(signings.length).toBeGreaterThan(1);
    const lastPart = puts.find(url => url.includes('/8?'));
    expect(lastPart).not.toContain('signing=1');
  });

  it('refuses a file not read to go in parts', async () => {
    await expect(send({ ...fileOf(2), partMd5s: [] })).rejects.toThrow(/not read to be sent/u);
  });
});
