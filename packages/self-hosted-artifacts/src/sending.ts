import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpBody from 'effect/http/HttpBody';
import type * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import { ClientError } from './client-support.ts';
import {
  MULTIPART_FROM_BYTES,
  PARTS_PER_SIGNING,
  partCountOf,
  partLengthOf,
  partSizeOf,
} from './protocol.ts';
import type { PartToSign, SignedPart } from './store-contract.ts';
import { executeWithoutUrl, isOk, UnavailableError, withRetries } from './transport.ts';

// What a target needs of a file on disk to send it: its digests, the whole of it as a request's body,
// and its parts, each sent and retried on its own.

const PARTS_IN_FLIGHT = 4;
const HASH_READ_BYTES = 1024 ** 2;
/** Well inside a URL's hour, so a part sent late in a slow batch doesn't find its URL expired. */
const SIGNED_URL_USABLE = Duration.minutes(45);

export type FileToSend = {
  readonly size: number;
  readonly digest: string;
  /** What each part's MD5 is, if it's big enough to go in parts, in part order. */
  readonly partMd5s: readonly string[];
  readonly wholeBody: (contentType: string | undefined) => HttpBody.Raw | HttpBody.Stream;
  /** Reads a part into the start of `into`, and answers with that much of it. */
  readonly readPart: (
    partNumber: number,
    into: Uint8Array,
  ) => Effect.Effect<Uint8Array, ClientError>;
};

/**
 * The SHA-256 of what is sent, which every target checks it against, and in the same pass the MD5 of
 * each part, so a batch of parts can be signed before any of them is read again. A plain loop over one
 * buffer, as a buffer per read would have the file's size pass through memory for the GC to catch up on.
 */
const hashFile = async ({ path, size }: { path: string; size: number }) => {
  const sha256 = createHash('sha256');
  const partSize = partSizeOf(size);
  const isInParts = size >= MULTIPART_FROM_BYTES;
  const partMd5s: string[] = [];
  let md5 = createHash('md5');
  let inPart = 0;
  let total = 0;
  const buffer = Buffer.allocUnsafeSlow(HASH_READ_BYTES);
  await using file = await open(path, 'r');
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    sha256.update(chunk);
    total += bytesRead;
    for (let offset = 0; isInParts && offset < bytesRead; ) {
      const end = Math.min(bytesRead, offset + partSize - inPart);
      md5.update(chunk.subarray(offset, end));
      inPart += end - offset;
      offset = end;
      if (inPart === partSize) {
        partMd5s.push(md5.digest('base64'));
        md5 = createHash('md5');
        inPart = 0;
      }
    }
  }
  if (inPart > 0) partMd5s.push(md5.digest('base64'));
  return { digest: sha256.digest('hex'), partMd5s, total };
};

/**
 * Fills `into` from where the part starts, as a read can stop short. Answers with what it read and how
 * long the file is by then, as bytes added past the end would change no part and go unseen.
 */
const readRange = async ({
  path,
  position,
  into,
}: {
  path: string;
  position: number;
  into: Uint8Array;
}) => {
  await using file = await open(path, 'r');
  let filled = 0;
  while (filled < into.length) {
    const { bytesRead } = await file.read(into, filled, into.length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return { filled, sizeNow: (await file.stat()).size };
};

export const openFileToSend = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = () => new ClientError({ message: `Can't read ${path}` });
  const size = Number((yield* fs.stat(path).pipe(Effect.mapError(unreadable))).size);
  const blob = yield* Effect.tryPromise({ try: () => openAsBlob(path), catch: unreadable });
  const { total, ...hashes } = yield* Effect.tryPromise({
    try: () => hashFile({ path, size }),
    catch: unreadable,
  });
  if (total !== size) {
    return yield* new ClientError({ message: `${path} changed while it was being read` });
  }
  const file: FileToSend = {
    size,
    ...hashes,
    // `fetch` sends a Blob's size as the length, and Node keeps that in 32 bits, so past 4 GiB it's
    // wrong. A stream has no length to get wrong, which only a disk's server can take: a bucket's
    // `PUT` signs the length, and what's that big goes to a bucket in parts.
    wholeBody: contentType =>
      blob.size === size
        ? HttpBody.raw(blob, { contentType })
        : HttpBody.stream(fs.stream(path), contentType),
    readPart: (partNumber, into) =>
      Effect.gen(function* () {
        const length = partLengthOf(size, partNumber);
        const bytes = into.subarray(0, length);
        const { filled, sizeNow } = yield* Effect.tryPromise({
          try: () =>
            readRange({ path, position: (partNumber - 1) * partSizeOf(size), into: bytes }),
          catch: unreadable,
        });
        return filled === length && sizeNow === size
          ? bytes
          : yield* new ClientError({ message: `${path} changed while it was being sent` });
      }),
  };
  return file;
});

/** Only its code, as with any other answer of a bucket's: the rest can hold what it signed. */
const readPartFailure = Effect.fnUntraced(function* (
  partNumber: number,
  response: HttpClientResponse.HttpClientResponse,
) {
  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
  const code = /<Code>([A-Za-z]+)<\/Code>/u.exec(body)?.[1];
  const message = `Part ${partNumber}: HTTP ${response.status}${code === undefined ? '' : `: ${code}`}`;
  return response.status >= 500 || response.status === 429
    ? new UnavailableError({ message })
    : new ClientError({ message });
});

/**
 * Sends every part, a batch of URLs at a time, and answers with what the bucket holds. Only a failed
 * part is sent again. It's read only as it's sent, so what's in memory is what's in flight.
 */
export const sendParts = Effect.fnUntraced(function* ({
  client,
  file,
  sign,
}: {
  client: HttpClient.HttpClient;
  file: FileToSend;
  sign: (parts: readonly PartToSign[]) => Effect.Effect<readonly SignedPart[], ClientError>;
}) {
  const parts = file.partMd5s.map((md5, index): PartToSign => ({ partNumber: index + 1, md5 }));
  if (parts.length !== partCountOf(file.size)) {
    return yield* new ClientError({ message: 'This file was not read to be sent in parts' });
  }

  // One buffer per part in flight, and none held while a part waits to retry. Reused rather than
  // allocated per part, as the GC would let several times these pile up.
  const buffers: Uint8Array[] = [];
  const withBuffer = <A, E>(use: (buffer: Uint8Array) => Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => buffers.pop() ?? new Uint8Array(partSizeOf(file.size))),
      use,
      buffer => Effect.sync(() => buffers.push(buffer)),
    );

  const sendPart = ({ partNumber, url, headers }: SignedPart) =>
    withBuffer(buffer =>
      Effect.gen(function* () {
        const bytes = yield* file.readPart(partNumber, buffer);
        const addressed = HttpClientRequest.put(url).pipe(HttpClientRequest.setHeaders(headers));
        const response = yield* executeWithoutUrl(
          client,
          // No content type: it isn't signed, and a part has none of its own.
          HttpClientRequest.setBody(addressed, HttpBody.raw(bytes)),
        );
        if (!isOk(response)) return yield* yield* readPartFailure(partNumber, response);
        const { etag } = response.headers;
        if (etag === undefined) {
          return yield* new ClientError({ message: `Part ${partNumber}: no ETag in the answer` });
        }
        return { partNumber, etag };
      }),
    );

  const sent = yield* Effect.forEach(
    Arr.chunksOf(parts, PARTS_PER_SIGNING),
    batch =>
      Effect.gen(function* () {
        const usableUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(SIGNED_URL_USABLE);
        const signed = yield* sign(batch);
        return yield* Effect.forEach(
          signed,
          part =>
            withRetries(
              Effect.gen(function* () {
                if ((yield* Clock.currentTimeMillis) < usableUntil) return yield* sendPart(part);
                const again = yield* sign(batch.filter(p => p.partNumber === part.partNumber));
                const [fresh] = again;
                return fresh === undefined
                  ? yield* new ClientError({ message: `Part ${part.partNumber} was not signed` })
                  : yield* sendPart(fresh);
              }),
            ),
          { concurrency: PARTS_IN_FLIGHT },
        );
      }),
    { concurrency: 1 },
  );
  return sent.flat();
});
