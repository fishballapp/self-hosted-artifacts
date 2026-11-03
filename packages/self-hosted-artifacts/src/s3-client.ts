import { createHash } from 'node:crypto';
import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { ClientError } from './client-support.ts';
import {
  BAD_RETENTION,
  FILE_NAME,
  FILE_NAME_MESSAGE,
  NAME_TAKEN,
  newArtifactId,
  OTHER_REPOSITORY,
  RUN_ID,
} from './protocol.ts';
import { encodeS3Path, encodeS3Query, type S3Credentials, signS3Request } from './s3-sigv4.ts';
import type { Target } from './target.ts';
import {
  executeRequest,
  isOk,
  type ListedArtifact,
  StoredArtifactFields,
  streamBodyToFile,
  UnavailableError,
  unavailableFrom,
  withRetries,
} from './transport.ts';

// The target with no server: artifacts in a bucket, with the metadata key as the only commit
// (DECISIONS.md). Everything above the `Target` it makes is shared with the server's.

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const COMMIT_ATTEMPTS = 8;
const LINK_LABEL = 's3';
const PARALLEL_READS = 16;
// So it can't slow a build noticeably. What this leaves waits for the next upload or the bucket's
// lifecycle rule, and every read already ignores it.
const SWEEP_KEYS = 100;
const SWEEP_PARALLEL = 8;
const SWEEP_BUDGET = Duration.seconds(3);
/** `artifacts/<id>/<name>` carries where its metadata is, so a delete by ID is a few requests. */
const SCOPE_HEADER = 'x-amz-meta-run-scope';

const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const REGION = /^[A-Za-z0-9-]{1,64}$/u;
const HTTP_BASE = /^https?:\/\/[^\s?#]+$/u;
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
type ArtifactFile = typeof ArtifactFileSchema.Type;
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

type RunScope = {
  readonly repositoryId: string;
  readonly runId: string;
  readonly runAttempt: string;
};

/** What a name holds now, and the ETag a write has to name to change it. */
type Held = { readonly artifact: ArtifactFile; readonly etag: string };

/** A URL its later uses can't throw on: `URL` takes a bad escape in a path, and decoding it doesn't. */
const isHttpBase = (text: string) => {
  const url = HTTP_BASE.test(text) ? URL.parse(text) : null;
  if (url === null) return false;
  try {
    decodeURIComponent(url.pathname);
    return true;
  } catch {
    return false;
  }
};

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

const nameKeyOf = ({ repositoryId, runId, runAttempt }: RunScope, name: string) =>
  `runs/${repositoryId}/${runId}/${runAttempt}/${sha256Hex(name)}.json`;

const repositoryKeyOf = (name: string) => `repositories/${sha256Hex(name.toLowerCase())}.json`;

const dataKeyOf = ({ id, name }: { id: string; name: string }) => `artifacts/${id}/${name}`;

const isExpired = ({ expiresAt }: ArtifactFile, nowMs: number) => Date.parse(expiresAt) <= nowMs;

const expiryAfter = ({ retentionDays, nowMs }: { retentionDays: number; nowMs: number }) =>
  new Date(
    nowMs +
      Math.min(retentionDays === 0 ? DEFAULT_RETENTION_DAYS : retentionDays, MAX_RETENTION_DAYS) *
        MS_PER_DAY,
  ).toISOString();

/** Lost an `If-*` race, or S3 asks to try again: read what's there now and decide afresh. */
class CommitConflictError extends Schema.TaggedError<CommitConflictError>()(
  'CommitConflictError',
  {},
) {}

const unescapeXml = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

const elementOf = (xml: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(xml)?.[1];

/**
 * Never the rest of the body: `SignatureDoesNotMatch` answers with the string it signed and the
 * access key ID.
 */
const readFailure = Effect.fnUntraced(function* (
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

const readScope = Effect.fnUntraced(function* (scope: string) {
  if (scope !== '') {
    if (!SCOPE.test(scope)) {
      return yield* new ClientError({
        message: `Invalid scope: '${scope}'. Must be <repository ID>/<run ID>/<run attempt>, each a number`,
      });
    }
    const [repositoryId = '', runId = '', runAttempt = ''] = scope.split('/');
    return { scope: { repositoryId, runId, runAttempt }, repositoryName: undefined };
  }
  const repositoryId = yield* Config.String('GITHUB_REPOSITORY_ID').pipe(Config.withDefault(''));
  const runId = yield* Config.String('GITHUB_RUN_ID').pipe(Config.withDefault(''));
  const runAttempt = yield* Config.String('GITHUB_RUN_ATTEMPT').pipe(Config.withDefault(''));
  if (![repositoryId, runId, runAttempt].every(part => RUN_ID.test(part))) {
    return yield* new ClientError({
      message:
        'No run to work in: S3 takes it from GITHUB_REPOSITORY_ID, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT in a GitHub Actions job, and from --scope <repository ID>/<run ID>/<run attempt> outside one',
    });
  }
  const repositoryName = yield* Config.String('GITHUB_REPOSITORY').pipe(Config.withDefault(''));
  return {
    scope: { repositoryId, runId, runAttempt },
    repositoryName: repositoryName === '' ? undefined : repositoryName,
  };
});

const readConnection = Effect.fnUntraced(
  function* ({ region: regionInput, scope: scopeInput }: { region: string; scope: string }) {
    // Empty as much as unset: a workflow's `env` passes a secret it doesn't have as empty.
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
    const regionFromEnvironment = yield* Config.String('AWS_REGION').pipe(Config.withDefault(''));
    const region = regionInput === '' ? regionFromEnvironment : regionInput;
    if (region === '') {
      return yield* new ClientError({
        message: 'No S3 region: set s3-region or AWS_REGION. On R2 it is `auto`',
      });
    }
    if (!REGION.test(region)) {
      return yield* new ClientError({ message: `Invalid S3 region: '${region}'` });
    }
    const credentials: S3Credentials = {
      accessKeyId,
      secretAccessKey: Redacted.make(secretAccessKey),
      ...(sessionToken === '' ? {} : { sessionToken: Redacted.make(sessionToken) }),
    };
    return { credentials, region, ...(yield* readScope(scopeInput)) };
  },
  Effect.catchTag('ConfigError', Effect.die),
);

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

export const makeS3Target = Effect.fnUntraced(function* ({
  bucket,
  region: regionInput,
  endpoint: endpointInput,
  linkBase: linkBaseInput,
  scope: scopeInput,
}: {
  bucket: string;
  region: string;
  endpoint: string;
  linkBase: string;
  scope: string;
}) {
  if (!BUCKET.test(bucket)) {
    return yield* new ClientError({ message: `Invalid s3-bucket: '${bucket}'` });
  }
  if (linkBaseInput === '') {
    return yield* new ClientError({
      message: "s3-link-base is required with s3-bucket: it is what an artifact's link starts with",
    });
  }
  if (!isHttpBase(linkBaseInput)) {
    return yield* new ClientError({
      message: 's3-link-base must be an http or https URL, with no query or fragment',
    });
  }
  if (endpointInput !== '' && !isHttpBase(endpointInput)) {
    return yield* new ClientError({
      message: 's3-endpoint must be an http or https URL, with no query or fragment',
    });
  }
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const linkBase = linkBaseInput.replace(/\/+$/u, '');
  const connection = yield* Effect.cached(
    readConnection({ region: regionInput, scope: scopeInput }),
  );

  const execute = Effect.fnUntraced(function* ({
    method,
    key,
    query = {},
    headers = {},
    body,
  }: {
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
    key: string;
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    body?: { readonly content: Blob | string; readonly contentType: string };
  }) {
    const { credentials, region } = yield* connection;
    const { origin, host, path } = s3AddressOf({ bucket, region, endpoint: endpointInput, key });
    const { host: _host, ...signed } = signS3Request({
      method,
      host,
      path,
      query,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': body.contentType }),
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
        // `If-Match` never matches.
        headers: { ...signed, ...(method === 'GET' ? { 'accept-encoding': 'identity' } : {}) },
      },
    );
    return yield* executeRequest(
      client,
      body === undefined
        ? request
        : HttpClientRequest.setBody(
            request,
            HttpBody.raw(body.content, { contentType: body.contentType }),
          ),
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
        Console.error(`Couldn't remove ${key}, which the bucket's lifecycle rule will`),
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
      // Every key this reads back was written here, with nothing in it that XML would escape.
      keys: Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/gu), ([, key = '']) => key),
      next:
        elementOf(xml, 'IsTruncated') === 'true' && next !== undefined
          ? Option.some(unescapeXml(next))
          : Option.none<string>(),
    };
  });

  const listKeys = (prefix: string) =>
    Stream.paginate(Option.none<string>(), continuationToken =>
      withRetries(
        listPage({
          prefix,
          ...(Option.isSome(continuationToken)
            ? { continuationToken: continuationToken.value }
            : {}),
        }),
      ).pipe(Effect.map(({ keys, next }) => [keys, Option.map(next, Option.some)] as const)),
    ).pipe(Stream.runCollect);

  const describeStored = ({ id, name, expiresAt }: ArtifactFile) => {
    const artifactUrl = `${linkBase}/${dataKeyOf({ id, name })}`;
    return { id, artifactUrl, links: { [LINK_LABEL]: artifactUrl }, expiresAt };
  };

  const repositoryIdOf = Effect.fnUntraced(function* (repository: string) {
    const { scope, repositoryName } = yield* connection;
    if (repository === '' || repository.toLowerCase() === repositoryName?.toLowerCase()) {
      return Option.some(scope.repositoryId);
    }
    const key = repositoryKeyOf(repository);
    const file = yield* withRetries(readObject(key));
    if (Option.isNone(file)) return Option.none();
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
    yield* withRetries(
      Effect.gen(function* () {
        const response = yield* execute({
          method: 'PUT',
          key,
          body: { content: body, contentType: 'application/json' },
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
    const tryToCommit = Effect.gen(function* () {
      const held = yield* readHeld(key);
      if (Option.isSome(held) && held.value.artifact.id === artifact.id) {
        return { _tag: 'Stored', replaced: replacing } as const;
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
      const response = yield* execute({
        method: 'PUT',
        key,
        headers: heldEtag === null ? { 'if-none-match': '*' } : { 'if-match': heldEtag },
        body: { content: body, contentType: 'application/json' },
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
      return { _tag: 'Stored', replaced: replacing } as const;
    });
    return yield* withRetries(
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
   * Best-effort, and never failing what called it. Data first: a name left behind is one no read
   * sees, and the next sweep finds it again, where data left behind would only have the lifecycle
   * rule. Oldest runs first, as keys sort. Long-lived artifacts at the front can keep this from
   * reaching later ones, which then wait for that rule.
   */
  const sweepExpired = (repositoryId: string) =>
    Effect.gen(function* () {
      const { keys } = yield* listPage({ prefix: `runs/${repositoryId}/`, maxKeys: SWEEP_KEYS });
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        keys,
        key =>
          Effect.gen(function* () {
            const held = yield* readHeld(key);
            if (Option.isNone(held) || !isExpired(held.value.artifact, nowMs)) return;
            yield* deleteObject(dataKeyOf(held.value.artifact));
            yield* deleteObject(key);
            // One that can't be read or removed doesn't stop the rest.
          }).pipe(Effect.ignore),
        { concurrency: SWEEP_PARALLEL, discard: true },
      );
    }).pipe(Effect.timeout(SWEEP_BUDGET), Effect.ignoreCause);

  return {
    ready: Effect.asVoid(connection),

    send: Effect.fnUntraced(function* ({ file, name, digest, overwrite, retentionDays }) {
      if (!FILE_NAME.test(name)) return yield* new ClientError({ message: FILE_NAME_MESSAGE });
      if (retentionDays < 0) return yield* new ClientError({ message: BAD_RETENTION });
      const { scope, repositoryName } = yield* connection;

      // With the digest, a retried upload or a refusal needs none of the body.
      const nowMs = yield* Clock.currentTimeMillis;
      const held = yield* withRetries(readHeld(nameKeyOf(scope, name)));
      if (Option.isSome(held) && !isExpired(held.value.artifact, nowMs)) {
        if (held.value.artifact.digest === digest) return describeStored(held.value.artifact);
        if (!overwrite) return yield* new ClientError({ message: NAME_TAKEN });
      }

      const artifact: ArtifactFile = {
        ...scope,
        id: newArtifactId(),
        name,
        size: file.size,
        digest,
        expiresAt: expiryAfter({ retentionDays, nowMs }),
      };
      const dataKey = dataKeyOf(artifact);
      yield* withRetries(
        Effect.gen(function* () {
          const response = yield* execute({
            method: 'PUT',
            key: dataKey,
            headers: {
              'content-disposition': 'attachment',
              'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
              [SCOPE_HEADER]: `${scope.repositoryId}/${scope.runId}/${scope.runAttempt}`,
            },
            body: { content: file, contentType: 'application/octet-stream' },
          });
          if (!isOk(response)) return yield* yield* readFailure(`store ${name}`, response);
        }),
      ).pipe(Effect.tapError(() => deleteOrNote(dataKey)));

      if (repositoryName !== undefined) {
        yield* recordRepository({ repositoryName, repositoryId: scope.repositoryId });
      }
      const outcome = yield* commit({ artifact, overwrite });
      if (outcome._tag === 'NameTaken') {
        yield* deleteOrNote(dataKey);
        return yield* new ClientError({ message: NAME_TAKEN });
      }
      if (outcome._tag === 'Displaced') {
        yield* deleteOrNote(dataKey);
        return yield* new ClientError({
          message: `${name} was replaced or deleted while it was being stored. Run this again`,
        });
      }
      if (outcome._tag === 'AlreadyThere') {
        yield* deleteOrNote(dataKey);
        return describeStored(outcome.artifact);
      }
      if (Option.isSome(outcome.replaced)) {
        yield* deleteOrNote(dataKeyOf(outcome.replaced.value));
      }
      yield* sweepExpired(scope.repositoryId);
      return describeStored(artifact);
    }),

    list: Effect.fnUntraced(function* ({ repository, runId, names = [], ids = [] }) {
      const { scope } = yield* connection;
      const repositoryId = yield* repositoryIdOf(repository);
      if (Option.isNone(repositoryId)) return [];
      const keys = yield* listKeys(
        `runs/${repositoryId.value}/${runId === '' ? scope.runId : runId}/`,
      );
      const wanted = new Set(names.map(sha256Hex));
      const nameKeys = keys.flatMap(key => {
        const [, runAttempt, nameHash] = RUN_KEY.exec(key) ?? [];
        if (runAttempt === undefined || nameHash === undefined) return [];
        return wanted.size === 0 || wanted.has(nameHash) ? [{ key, runAttempt }] : [];
      });
      // Oldest attempt first, compared as numbers, so the latest for a name is the one a Map keeps.
      const oldestFirst = nameKeys.toSorted((a, b) => Number(a.runAttempt) - Number(b.runAttempt));
      const held = yield* Effect.forEach(oldestFirst, ({ key }) => withRetries(readHeld(key)), {
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
      )
        .filter(({ id }) => ids.length === 0 || ids.includes(id))
        .map(
          (artifact): ListedArtifact => ({
            ...artifact,
            links: describeStored(artifact).links,
          }),
        );
    }),

    // Signed, not the link: a link's base is what people use, and a runner may not reach it.
    fetch: ({ artifact, target }) =>
      withRetries(
        Effect.gen(function* () {
          const response = yield* execute({ method: 'GET', key: dataKeyOf(artifact) });
          if (!isOk(response)) {
            return yield* yield* readFailure(`read ${artifact.name}`, response);
          }
          return yield* streamBodyToFile({ fs, response, artifact, target });
        }),
      ),

    remove: Effect.fnUntraced(function* (id) {
      const { scope } = yield* connection;
      const notFound = new ClientError({ message: 'Not found' });
      const { keys } = yield* withRetries(listPage({ prefix: `artifacts/${id}/`, maxKeys: 1 }));
      const [dataKey] = keys;
      if (dataKey === undefined) return yield* notFound;
      const name = dataKey.slice(`artifacts/${id}/`.length);

      const head = yield* withRetries(
        Effect.gen(function* () {
          const response = yield* execute({ method: 'HEAD', key: dataKey });
          if (response.status === 404) return undefined;
          if (!isOk(response)) return yield* yield* readFailure(`read ${name}`, response);
          return response.headers[SCOPE_HEADER];
        }),
      );
      if (head === undefined || !SCOPE.test(head)) return yield* notFound;
      const [repositoryId = '', runId = '', runAttempt = ''] = head.split('/');
      const nameKey = nameKeyOf({ repositoryId, runId, runAttempt }, name);

      const held = yield* withRetries(readHeld(nameKey));
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        Option.isNone(held) ||
        held.value.artifact.id !== id ||
        isExpired(held.value.artifact, nowMs)
      ) {
        return yield* notFound;
      }
      if (held.value.artifact.repositoryId !== scope.repositoryId) {
        return yield* new ClientError({ message: OTHER_REPOSITORY });
      }
      // The name first, which is the commit: anything left after it can't be found by any read.
      yield* withRetries(deleteObject(nameKey));
      yield* withRetries(deleteObject(dataKey)).pipe(
        Effect.mapError(
          ({ message }) =>
            new ClientError({
              message: `${name} is gone from its run, but its link still works until the bucket's lifecycle rule removes ${dataKey}: ${message}`,
            }),
        ),
      );
      return { id, name };
    }),
  } satisfies Target;
});
