import { createHash } from 'node:crypto';
import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpBody from 'effect/http/HttpBody';
import type * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { ClientError } from './client-support.ts';
import { isFileName, partLengthOf, RUN_ID } from './protocol.ts';
import {
  encodeS3Path,
  encodeS3Query,
  presignS3Request,
  type S3Credentials,
  signS3Request,
} from './s3-sigv4.ts';
import type { PartToSign, RunScope, SentPart, SignedPart } from './store-contract.ts';
import {
  executeRequest,
  executeWithoutUrl,
  isOk,
  StoredArtifactFields,
  UnavailableError,
  unavailableFrom,
  unavailableWithoutUrl,
  withRetries,
} from './transport.ts';

// What a bucket is to anything holding its keys, whether a job with no server or a server in front
// of it: the layout, signed requests, and the metadata key as the only commit (DECISIONS.md). Which
// run this is comes in as an argument. A Worker runs this too, so it imports nothing of Node's but
// `node:crypto`, and doesn't touch `Temporal`.

const COMMIT_ATTEMPTS = 8;
const PARALLEL_READS = 16;
export const UPLOAD_URL_SECONDS = 60 * 60;
const ABORT_BUDGET = Duration.seconds(10);
/** `artifacts/<id>/<name>` carries where its metadata is, so finding it by ID is a few requests. */
export const SCOPE_HEADER = 'x-amz-meta-run-scope';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const SCOPE = /^[0-9]{1,32}\/[0-9]{1,32}\/[0-9]{1,32}$/u;
const RUN_KEY = /^runs\/[0-9]+\/[0-9]+\/([0-9]+)\/([0-9a-f]{64})\.json$/u;

const ArtifactFileSchema = Schema.fromJsonString(
  Schema.Struct({
    ...StoredArtifactFields,
    expiresAt: Schema.String.check(Schema.isPattern(INSTANT)),
    repositoryId: Schema.String.check(Schema.isPattern(RUN_ID)),
    runId: Schema.String.check(Schema.isPattern(RUN_ID)),
    runAttempt: Schema.String.check(Schema.isPattern(RUN_ID)),
  }),
);
export type ArtifactFile = typeof ArtifactFileSchema.Type;
const decodeArtifactFile = Schema.decodeUnknownEffect(ArtifactFileSchema);
const encodeArtifactFile = Schema.encodeEffect(ArtifactFileSchema);

const RepositoryFileSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    repositoryId: Schema.String.check(Schema.isPattern(RUN_ID)),
  }),
);
const decodeRepositoryFile = Schema.decodeUnknownEffect(RepositoryFileSchema);
const encodeRepositoryFile = Schema.encodeEffect(RepositoryFileSchema);

/** What a name holds now, and the ETag a write has to name to change it. */
type Held = { readonly artifact: ArtifactFile; readonly etag: string };

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

export const nameKeyOf = ({ repositoryId, runId, runAttempt }: RunScope, name: string) =>
  `runs/${repositoryId}/${runId}/${runAttempt}/${sha256Hex(name)}.json`;

const repositoryKeyOf = (name: string) => `repositories/${sha256Hex(name.toLowerCase())}.json`;

export const dataKeyOf = ({ id, name }: { id: string; name: string }) => `artifacts/${id}/${name}`;

export const isExpired = ({ expiresAt }: ArtifactFile, nowMs: number) =>
  Date.parse(expiresAt) <= nowMs;

export const scopeHeaderOf = ({ repositoryId, runId, runAttempt }: RunScope) =>
  `${repositoryId}/${runId}/${runAttempt}`;

/** The scope a data key's header names, unless that isn't one. */
export const scopeFromHeader = (header: string | undefined): Option.Option<RunScope> => {
  if (header === undefined || !SCOPE.test(header)) return Option.none();
  const [repositoryId = '', runId = '', runAttempt = ''] = header.split('/');
  return Option.some({ repositoryId, runId, runAttempt });
};

/** What the data key says of itself: how it's served, and the scope a commit and a link go by. */
export const dataHeadersOf = (scope: RunScope) => ({
  'content-type': 'application/octet-stream',
  'content-disposition': 'attachment',
  [SCOPE_HEADER]: scopeHeaderOf(scope),
});

/** What `x-amz-checksum-sha256` takes, from a digest in hex. */
export const checksumOf = (digest: string) => Buffer.from(digest, 'hex').toString('base64');

/** Empty as much as unset: a workflow's `env` passes a secret it doesn't have as empty. */
export const readS3Credentials = Effect.gen(function* () {
  const accessKeyId = yield* Config.String('AWS_ACCESS_KEY_ID').pipe(Config.withDefault(''));
  const secretAccessKey = yield* Config.String('AWS_SECRET_ACCESS_KEY').pipe(
    Config.withDefault(''),
  );
  const sessionToken = yield* Config.String('AWS_SESSION_TOKEN').pipe(Config.withDefault(''));
  if (accessKeyId === '' || secretAccessKey === '') {
    return yield* new ClientError({
      message:
        'No S3 credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN with temporary ones',
    });
  }
  const credentials: S3Credentials = {
    accessKeyId,
    secretAccessKey: Redacted.make(secretAccessKey),
    ...(sessionToken === '' ? {} : { sessionToken: Redacted.make(sessionToken) }),
  };
  return credentials;
}).pipe(Effect.catchTag('ConfigError', Effect.die));

/** Virtual-hosted on AWS, and path-style with an endpoint, as R2's, MinIO's and the like take. */
export const s3AddressOf = ({
  bucket,
  region,
  endpoint,
  key,
}: {
  bucket: string;
  region: string;
  endpoint: string;
  key: string;
}) => {
  if (endpoint === '') {
    // Through `URL`, which lowers its case as `fetch` will: the signature covers the host it sends.
    const { origin, host } = new URL(`https://${bucket}.s3.${region}.amazonaws.com`);
    return { origin, host, path: `/${key}` };
  }
  const { origin, host, pathname } = new URL(endpoint);
  // Decoded, as the path is encoded once on its way out, and its escapes would be encoded again.
  const bucketPath = `${decodeURIComponent(pathname).replace(/\/+$/u, '')}/${bucket}`;
  return { origin, host, path: key === '' ? bucketPath : `${bucketPath}/${key}` };
};

/** Lost an `If-*` race, or S3 asks to try again: read what's there now and decide afresh. */
class CommitConflictError extends Schema.TaggedError<CommitConflictError>()(
  'CommitConflictError',
  {},
) {}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

const MAX_CODE_POINT = 0x10ffff;

/** By name or by number, each store having its own way: MinIO writes `'` as `&#39;`. */
export const unescapeXml = (text: string) =>
  text.replaceAll(
    /&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|(lt|gt|quot|apos|amp));/gu,
    (match, decimal?: string, hex?: string, named?: string) => {
      if (named !== undefined) return XML_ENTITIES[named] ?? match;
      const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : match;
    },
  );

const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const elementOf = (xml: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(xml)?.[1];

/**
 * Never the rest of the body: `SignatureDoesNotMatch` answers with the string it signed and the
 * access key ID.
 */
export const readFailure = Effect.fnUntraced(function* (
  action: string,
  response: HttpClientResponse.HttpClientResponse,
) {
  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
  const code = elementOf(body, 'Code') ?? `HTTP ${response.status}`;
  const message = `S3 refused to ${action}: ${code}${
    elementOf(body, 'Message') === undefined ? '' : ` (${elementOf(body, 'Message')})`
  }`;
  return response.status >= 500 || response.status === 429
    ? new UnavailableError({ message })
    : new ClientError({ message });
});

export const makeS3Bucket = ({
  client,
  bucket,
  endpoint,
  connection,
  note,
}: {
  client: HttpClient.HttpClient;
  bucket: string;
  /** Empty on AWS. */
  endpoint: string;
  connection: Effect.Effect<
    { readonly credentials: S3Credentials; readonly region: string },
    ClientError
  >;
  /** Where to say what's worth saying and isn't a failure. It may hold a key, with its token. */
  note: (message: string) => Effect.Effect<void>;
}) => {
  const retrying = <A, R>(attempt: Effect.Effect<A, ClientError | UnavailableError, R>) =>
    withRetries(attempt, note);

  const execute = Effect.fnUntraced(function* ({
    method,
    key,
    query = {},
    headers = {},
    body,
    isUrlSecret = false,
  }: {
    method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';
    key: string;
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    body?: HttpBody.Raw | HttpBody.Uint8Array | HttpBody.Stream;
    /** An upload's ID is in it. */
    isUrlSecret?: boolean;
  }) {
    const { credentials, region } = yield* connection;
    const { origin, host, path } = s3AddressOf({ bucket, region, endpoint, key });
    const { host: _host, ...signed } = signS3Request({
      method,
      host,
      path,
      query,
      headers: {
        ...headers,
        ...(body?.contentType === undefined ? {} : { 'content-type': body.contentType }),
      },
      credentials,
      region,
      nowMs: yield* Clock.currentTimeMillis,
    });
    const search = encodeS3Query(query);
    const request = HttpClientRequest.make(method)(
      `${origin}${encodeS3Path(path)}${search === '' ? '' : `?${search}`}`,
      {
        // `fetch` asks for gzip by default. R2 would then compress, and answer with a weak ETag that
        // `If-Match` never matches, or no length.
        headers: {
          ...signed,
          ...(method === 'GET' || method === 'HEAD' ? { 'accept-encoding': 'identity' } : {}),
        },
      },
    );
    return yield* (isUrlSecret ? executeWithoutUrl : executeRequest)(
      client,
      body === undefined ? request : HttpClientRequest.setBody(request, body),
    );
  });

  const readObject = Effect.fnUntraced(function* (key: string) {
    const response = yield* execute({ method: 'GET', key });
    if (response.status === 404) return Option.none();
    if (!isOk(response)) return yield* yield* readFailure(`read ${key}`, response);
    const text = yield* response.text.pipe(Effect.mapError(unavailableFrom));
    const etag = response.headers.etag;
    if (etag === undefined) {
      return yield* new ClientError({ message: `S3 answered for ${key} with no ETag` });
    }
    return Option.some({ text, etag });
  });

  const unusable = (key: string) =>
    new ClientError({ message: `${bucket} holds something unusable at ${key}` });

  /** Held to the rules of a stored artifact, as its ID and name go into a URL and a path here. */
  const readHeld = (
    key: string,
  ): Effect.Effect<Option.Option<Held>, ClientError | UnavailableError> =>
    readObject(key).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Held>()),
          onSome: ({ text, etag }) =>
            decodeArtifactFile(text).pipe(
              Effect.mapError(() => unusable(key)),
              Effect.map(artifact => Option.some({ artifact, etag })),
            ),
        }),
      ),
    );

  const deleteObject = Effect.fnUntraced(function* (key: string) {
    const response = yield* execute({ method: 'DELETE', key });
    if (!isOk(response)) return yield* yield* readFailure(`delete ${key}`, response);
  });

  /** For what only costs storage if it stays, which the bucket's lifecycle rule then removes. */
  const deleteOrNote = (key: string) =>
    deleteObject(key).pipe(
      Effect.catchCause(() =>
        note(`Couldn't remove ${key}, which the bucket's lifecycle rule will`),
      ),
    );

  const listPage = Effect.fnUntraced(function* ({
    prefix,
    maxKeys,
    continuationToken,
  }: {
    prefix: string;
    maxKeys?: number;
    continuationToken?: string;
  }) {
    const response = yield* execute({
      method: 'GET',
      key: '',
      query: {
        'list-type': '2',
        prefix,
        ...(maxKeys === undefined ? {} : { 'max-keys': String(maxKeys) }),
        ...(continuationToken === undefined ? {} : { 'continuation-token': continuationToken }),
      },
    });
    if (!isOk(response)) return yield* yield* readFailure(`list ${prefix}`, response);
    const xml = yield* response.text.pipe(Effect.mapError(unavailableFrom));
    const next = elementOf(xml, 'NextContinuationToken');
    return {
      keys: Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/gu), ([, key = '']) => unescapeXml(key)),
      next:
        elementOf(xml, 'IsTruncated') === 'true' && next !== undefined
          ? Option.some(unescapeXml(next))
          : Option.none<string>(),
    };
  });

  const listKeys = (prefix: string) =>
    Stream.paginate(Option.none<string>(), continuationToken =>
      retrying(
        listPage({
          prefix,
          ...(Option.isSome(continuationToken)
            ? { continuationToken: continuationToken.value }
            : {}),
        }),
      ).pipe(Effect.map(({ keys, next }) => [keys, Option.map(next, Option.some)] as const)),
    ).pipe(Stream.runCollect);

  /** Each name's latest attempt in a run, in name order, leaving out what has expired. */
  const latestInRun = Effect.fnUntraced(function* ({
    repositoryId,
    runId,
    names = [],
  }: {
    repositoryId: string;
    runId: string;
    names?: readonly string[];
  }) {
    const keys = yield* listKeys(`runs/${repositoryId}/${runId}/`);
    const wanted = new Set(names.map(sha256Hex));
    const nameKeys = keys.flatMap(key => {
      const [, runAttempt, nameHash] = RUN_KEY.exec(key) ?? [];
      if (runAttempt === undefined || nameHash === undefined) return [];
      return wanted.size === 0 || wanted.has(nameHash) ? [{ key, runAttempt }] : [];
    });
    // Oldest attempt first, compared as numbers, so the latest for a name is the one a Map keeps.
    const oldestFirst = nameKeys.toSorted((a, b) => Number(a.runAttempt) - Number(b.runAttempt));
    const held = yield* Effect.forEach(oldestFirst, ({ key }) => retrying(readHeld(key)), {
      concurrency: PARALLEL_READS,
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const live = Arr.getSomes(held)
      .map(({ artifact }) => artifact)
      .filter(artifact => !isExpired(artifact, nowMs));
    const latest = new Map(live.map(artifact => [artifact.name, artifact] as const));
    return Arr.sort(
      latest.values(),
      Order.mapInput(Order.String, ({ name }: ArtifactFile) => name),
    );
  });

  const findRepositoryId = Effect.fnUntraced(function* (repository: string) {
    const key = repositoryKeyOf(repository);
    const file = yield* retrying(readObject(key));
    if (Option.isNone(file)) return Option.none<string>();
    const { repositoryId } = yield* decodeRepositoryFile(file.value.text).pipe(
      Effect.mapError(() => unusable(key)),
    );
    return Option.some(repositoryId);
  });

  /**
   * On every upload, not only when it would change: the bucket's lifecycle rule goes by age, so this
   * stays younger than anything of this repository it could be needed to find.
   */
  const recordRepository = Effect.fnUntraced(function* ({
    repositoryName,
    repositoryId,
  }: {
    repositoryName: string;
    repositoryId: string;
  }) {
    const key = repositoryKeyOf(repositoryName);
    const body = yield* encodeRepositoryFile({ name: repositoryName, repositoryId }).pipe(
      Effect.orDie,
    );
    yield* retrying(
      Effect.gen(function* () {
        const response = yield* execute({
          method: 'PUT',
          key,
          body: HttpBody.text(body, 'application/json'),
        });
        if (!isOk(response)) return yield* yield* readFailure(`write ${key}`, response);
      }),
    );
  });

  const isDataThere = Effect.fnUntraced(function* (key: string) {
    const response = yield* execute({ method: 'HEAD', key });
    if (isOk(response)) return true;
    if ([403, 404].includes(response.status)) return false;
    return yield* yield* readFailure(`read ${key}`, response);
  });

  /** What a data key says of itself, if it's there. */
  const readDataHead = (key: string) =>
    retrying(
      Effect.gen(function* () {
        const response = yield* execute({ method: 'HEAD', key });
        if (response.status === 404) return Option.none();
        if (!isOk(response)) return yield* yield* readFailure(`read ${key}`, response);
        const { 'content-length': size, [SCOPE_HEADER]: scope } = response.headers;
        return Option.some({ size, scope });
      }),
    );

  /**
   * What makes an artifact exist. The name's key is written only over what was just read, so of two
   * jobs one wins, and a try whose answer was lost finds itself there on the next read.
   *
   * If it isn't there, that write may have landed and been replaced or deleted since, and whoever did
   * that deleted this data. So an unanswered write is only tried again over what it was first written
   * over, with the data still there: a name must never point at data that's gone.
   */
  const commit = Effect.fnUntraced(function* ({
    artifact,
    overwrite,
  }: {
    artifact: ArtifactFile;
    overwrite: boolean;
  }) {
    const key = nameKeyOf(artifact, artifact.name);
    const body = yield* encodeArtifactFile(artifact).pipe(Effect.orDie);
    // What the last write was replacing, for a read that finds that write landed after all.
    let replacing = Option.none<ArtifactFile>();
    // The ETag an unanswered write went over, with `null` for nothing there.
    let unansweredOver = Option.none<string | null>();
    let hasWritten = false;
    const tryToCommit = Effect.gen(function* () {
      const held = yield* readHeld(key);
      if (Option.isSome(held) && held.value.artifact.id === artifact.id) {
        return {
          _tag: 'Stored',
          artifact: held.value.artifact,
          isNew: hasWritten,
          replaced: replacing,
        } as const;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      if (Option.isSome(held) && !isExpired(held.value.artifact, nowMs)) {
        if (held.value.artifact.digest === artifact.digest) {
          return { _tag: 'AlreadyThere', artifact: held.value.artifact } as const;
        }
        if (!overwrite) return { _tag: 'NameTaken' } as const;
      }
      const heldEtag = Option.isSome(held) ? held.value.etag : null;
      if (Option.isSome(unansweredOver)) {
        const isUnchanged = unansweredOver.value === heldEtag;
        if (!isUnchanged || !(yield* isDataThere(dataKeyOf(artifact)))) {
          return { _tag: 'Displaced' } as const;
        }
      }
      replacing = Option.map(held, current => current.artifact);
      hasWritten = true;
      const response = yield* execute({
        method: 'PUT',
        key,
        headers: heldEtag === null ? { 'if-none-match': '*' } : { 'if-match': heldEtag },
        body: HttpBody.text(body, 'application/json'),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            unansweredOver = Option.some(heldEtag);
          }),
        ),
      );
      // 412 lost, 409 "conditional request conflict", and 404 for `If-Match` on what just went.
      if ([404, 409, 412].includes(response.status)) return yield* new CommitConflictError();
      if (!isOk(response)) {
        const failure = yield* readFailure(`write ${key}`, response);
        // A 5xx is no answer either: S3 may have stored it.
        if (Predicate.isTagged(failure, 'UnavailableError')) unansweredOver = Option.some(heldEtag);
        return yield* failure;
      }
      return { _tag: 'Stored', artifact, isNew: true, replaced: replacing } as const;
    });
    return yield* retrying(
      tryToCommit.pipe(
        Effect.retry({ while: Predicate.isTagged('CommitConflictError'), times: COMMIT_ATTEMPTS }),
        Effect.catchTag('CommitConflictError', () =>
          Effect.fail(
            new ClientError({
              message: `${artifact.name} kept changing while it was being stored`,
            }),
          ),
        ),
      ),
    );
  });

  /**
   * A live artifact by its ID alone, in three requests: list `artifacts/<id>/` for the name, `HEAD` it
   * for its scope, read the name's key.
   */
  const findLive = Effect.fnUntraced(function* (id: string) {
    const { keys } = yield* retrying(listPage({ prefix: `artifacts/${id}/`, maxKeys: 1 }));
    const [dataKey] = keys;
    if (dataKey === undefined) return Option.none();
    const name = dataKey.slice(`artifacts/${id}/`.length);
    if (!isFileName(name)) return Option.none();

    const head = yield* readDataHead(dataKey);
    const scope = Option.flatMap(head, ({ scope: header }) => scopeFromHeader(header));
    if (Option.isNone(scope)) return Option.none();
    const nameKey = nameKeyOf(scope.value, name);

    const held = yield* retrying(readHeld(nameKey));
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(held) ||
      held.value.artifact.id !== id ||
      isExpired(held.value.artifact, nowMs)
    ) {
      return Option.none();
    }
    return Option.some({ artifact: held.value.artifact, nameKey, dataKey });
  });

  /** The whole URL: `query` and `headers` are what S3 holds a request to it to. */
  const presign = Effect.fnUntraced(function* ({
    method,
    key,
    query,
    headers,
    expiresInSeconds,
  }: {
    method: 'GET' | 'PUT';
    key: string;
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    expiresInSeconds: number;
  }) {
    const { credentials, region } = yield* connection;
    const { origin, host, path } = s3AddressOf({ bucket, region, endpoint, key });
    const search = presignS3Request({
      method,
      host,
      path,
      ...(query === undefined ? {} : { query }),
      ...(headers === undefined ? {} : { headers }),
      credentials,
      region,
      nowMs: yield* Clock.currentTimeMillis,
      expiresInSeconds,
    });
    return `${origin}${encodeS3Path(path)}?${search}`;
  });

  /** S3's message is its own to word, so an upload's ID can't reach a log through it. */
  const withoutUploadId =
    (uploadId: string) =>
    <A, R>(self: Effect.Effect<A, ClientError | UnavailableError, R>) =>
      self.pipe(
        Effect.mapError(error =>
          Predicate.isTagged(error, 'UnavailableError')
            ? new UnavailableError({ message: error.message.replaceAll(uploadId, 'an upload') })
            : new ClientError({ message: error.message.replaceAll(uploadId, 'an upload') }),
        ),
      );

  /** Answers with the upload's ID, which is a credential. What `headers` say, the object will. */
  const startMultipart = ({
    key,
    headers,
  }: {
    key: string;
    headers: Readonly<Record<string, string>>;
  }) =>
    retrying(
      Effect.gen(function* () {
        const response = yield* execute({ method: 'POST', key, query: { uploads: '' }, headers });
        if (!isOk(response)) return yield* yield* readFailure(`start ${key}`, response);
        const xml = yield* response.text.pipe(Effect.mapError(unavailableWithoutUrl));
        const uploadId = elementOf(xml, 'UploadId');
        if (uploadId === undefined) {
          return yield* new ClientError({ message: `S3 answered for ${key} with no upload ID` });
        }
        return unescapeXml(uploadId);
      }),
    );

  /**
   * One URL per part, which is all signing: nothing asks the bucket. What's signed is what S3 holds a
   * part to: this key, this upload, this number, this length, and this MD5.
   */
  const signParts = ({
    key,
    uploadId,
    size,
    parts,
  }: {
    key: string;
    uploadId: string;
    size: number;
    parts: readonly PartToSign[];
  }) =>
    Effect.forEach(
      parts,
      ({ partNumber, md5 }) =>
        Effect.map(
          presign({
            method: 'PUT',
            key,
            query: { partNumber: String(partNumber), uploadId },
            headers: {
              'content-length': String(partLengthOf(size, partNumber)),
              'content-md5': md5,
            },
            expiresInSeconds: UPLOAD_URL_SECONDS,
          }),
          // No `content-length`: `fetch` strips one set by hand, and sets it from the bytes.
          (url): SignedPart => ({ partNumber, url, headers: { 'content-md5': md5 } }),
        ),
      { concurrency: 1 },
    );

  /**
   * Makes the object out of its parts. A `404` is what a store may say to a try whose first answer was
   * lost, as well as to what was never there, so this leaves that to the `HEAD` every caller makes next.
   */
  const completeMultipart = ({
    key,
    uploadId,
    parts,
  }: {
    key: string;
    uploadId: string;
    parts: readonly SentPart[];
  }) =>
    retrying(
      Effect.gen(function* () {
        const response = yield* execute({
          method: 'POST',
          key,
          query: { uploadId },
          isUrlSecret: true,
          body: HttpBody.text(
            `<CompleteMultipartUpload>${parts
              .map(
                ({ partNumber, etag }) =>
                  `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
              )
              .join('')}</CompleteMultipartUpload>`,
            'application/xml',
          ),
        });
        if (response.status === 404) return;
        if (!isOk(response)) return yield* yield* readFailure(`finish ${key}`, response);
        // S3 answers `200` before it knows, and then says how it went in the body.
        const xml = yield* response.text.pipe(Effect.mapError(unavailableWithoutUrl));
        const code = elementOf(xml, 'Code');
        if (code !== undefined) {
          return yield* new UnavailableError({ message: `S3 failed to finish ${key}: ${code}` });
        }
      }).pipe(withoutUploadId(uploadId)),
    );

  /** Never fails what called it, or holds it up for long: the bucket's rule removes what this leaves. */
  const abortMultipart = ({ key, uploadId }: { key: string; uploadId: string }) =>
    Effect.gen(function* () {
      const response = yield* execute({
        method: 'DELETE',
        key,
        query: { uploadId },
        isUrlSecret: true,
      });
      if (!isOk(response) && response.status !== 404) {
        return yield* yield* readFailure(`stop ${key}`, response);
      }
    }).pipe(
      Effect.timeout(ABORT_BUDGET),
      Effect.catchCause(() =>
        note(`Couldn't stop the upload of ${key}, which the bucket's lifecycle rule will`),
      ),
    );

  /** Whether a key holds what an upload declared. That's all a bucket can say of an upload in parts. */
  const holdsData = ({ key, size, scope }: { key: string; size: number; scope: RunScope }) =>
    Effect.map(
      readDataHead(key),
      Option.exists(
        ({ size: stored, scope: header }) =>
          stored === String(size) && header === scopeHeaderOf(scope),
      ),
    );

  return {
    retrying,
    execute,
    presign,
    startMultipart,
    signParts,
    completeMultipart,
    abortMultipart,
    holdsData,
    readHeld,
    deleteObject,
    deleteOrNote,
    listPage,
    latestInRun,
    findRepositoryId,
    recordRepository,
    readDataHead,
    commit,
    findLive,
  };
};
