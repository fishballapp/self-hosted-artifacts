import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpClient from 'effect/http/HttpClient';
import * as Option from 'effect/Option';
import { ClientError } from './client-support.ts';
import {
  BAD_RETENTION,
  FILE_NAME_MESSAGE,
  isFileName,
  isHttpBase,
  MULTIPART_FROM_BYTES,
  NAME_TAKEN,
  newArtifactId,
  OTHER_REPOSITORY,
  RUN_ID,
  S3_BUCKET,
  S3_REGION,
} from './protocol.ts';
import {
  type ArtifactFile,
  checksumOf,
  dataHeadersOf,
  dataKeyOf,
  isExpired,
  makeS3Bucket,
  nameKeyOf,
  readFailure,
  readS3Credentials,
} from './s3-bucket.ts';
import { encodeS3Path } from './s3-sigv4.ts';
import { type FileToSend, sendParts } from './sending.ts';
import type { RunScope } from './store-contract.ts';
import type { Target } from './target.ts';
import { isOk, type ListedArtifact, streamBodyToFile } from './transport.ts';

// The target with no server: a job holding a bucket's keys. Its run comes from its environment, as
// nothing verifies it, and everything above the `Target` it makes is shared with the server's.

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LINK_LABEL = 's3';
// So it can't slow a build noticeably. What this leaves waits for the next upload or the bucket's
// lifecycle rule, and every read already ignores it.
const SWEEP_KEYS = 100;
const SWEEP_PARALLEL = 8;
const SWEEP_BUDGET = Duration.seconds(3);

const SCOPE = /^[0-9]{1,32}\/[0-9]{1,32}\/[0-9]{1,32}$/u;

const expiryAfter = ({ retentionDays, nowMs }: { retentionDays: number; nowMs: number }) =>
  new Date(
    nowMs +
      Math.min(retentionDays === 0 ? DEFAULT_RETENTION_DAYS : retentionDays, MAX_RETENTION_DAYS) *
        MS_PER_DAY,
  ).toISOString();

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
    const credentials = yield* readS3Credentials;
    const regionFromEnvironment = yield* Config.String('AWS_REGION').pipe(Config.withDefault(''));
    const region = regionInput === '' ? regionFromEnvironment : regionInput;
    if (region === '') {
      return yield* new ClientError({
        message: 'No S3 region: set s3-region or AWS_REGION. On R2 it is `auto`',
      });
    }
    if (!S3_REGION.test(region)) {
      return yield* new ClientError({ message: `Invalid S3 region: '${region}'` });
    }
    return { credentials, region, ...(yield* readScope(scopeInput)) };
  },
  Effect.catchTag('ConfigError', Effect.die),
);

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
  if (!S3_BUCKET.test(bucket)) {
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

  const {
    retrying,
    execute,
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
    commit,
    findLive,
  } = makeS3Bucket({
    client,
    bucket,
    endpoint: endpointInput,
    connection,
    note: Console.error,
  });

  const describeStored = ({ id, name, expiresAt }: ArtifactFile) => {
    const artifactUrl = `${linkBase}/${encodeS3Path(dataKeyOf({ id, name }))}`;
    return { id, artifactUrl, links: { [LINK_LABEL]: artifactUrl }, expiresAt };
  };

  const repositoryIdOf = Effect.fnUntraced(function* (repository: string) {
    const { scope, repositoryName } = yield* connection;
    if (repository === '' || repository.toLowerCase() === repositoryName?.toLowerCase()) {
      return Option.some(scope.repositoryId);
    }
    return yield* findRepositoryId(repository);
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

  /** The object made out of its parts, or nothing but what the bucket's rule removes. */
  const putInParts = Effect.fnUntraced(function* ({
    key,
    name,
    file,
    scope,
  }: {
    key: string;
    name: string;
    file: FileToSend;
    scope: RunScope;
  }) {
    const uploadId = yield* startMultipart({ key, headers: dataHeadersOf(scope) });
    yield* Effect.gen(function* () {
      const parts = yield* sendParts({
        client,
        file,
        sign: batch => signParts({ key, uploadId, size: file.size, parts: batch }),
      });
      yield* completeMultipart({ key, uploadId, parts });
      if (!(yield* holdsData({ key, size: file.size, scope }))) {
        return yield* new ClientError({ message: `${name} isn't what was sent, once stored` });
      }
    }).pipe(Effect.onError(() => abortMultipart({ key, uploadId })));
  });

  /** One signed `PUT`, whose checksum S3 holds the whole file to. */
  const putWhole = ({
    key,
    name,
    file,
    scope,
  }: {
    key: string;
    name: string;
    file: FileToSend;
    scope: RunScope;
  }) =>
    retrying(
      Effect.gen(function* () {
        const response = yield* execute({
          method: 'PUT',
          key,
          headers: { ...dataHeadersOf(scope), 'x-amz-checksum-sha256': checksumOf(file.digest) },
          body: file.wholeBody('application/octet-stream'),
        });
        if (!isOk(response)) return yield* yield* readFailure(`store ${name}`, response);
      }),
    );

  return {
    ready: Effect.asVoid(connection),

    send: Effect.fnUntraced(function* ({ file, name, overwrite, retentionDays }) {
      if (!isFileName(name)) return yield* new ClientError({ message: FILE_NAME_MESSAGE });
      if (retentionDays < 0) return yield* new ClientError({ message: BAD_RETENTION });
      const { scope, repositoryName } = yield* connection;
      const { digest, size } = file;

      // With the digest, a retried upload or a refusal needs none of the body.
      const nowMs = yield* Clock.currentTimeMillis;
      const held = yield* retrying(readHeld(nameKeyOf(scope, name)));
      if (Option.isSome(held) && !isExpired(held.value.artifact, nowMs)) {
        if (held.value.artifact.digest === digest) return describeStored(held.value.artifact);
        if (!overwrite) return yield* new ClientError({ message: NAME_TAKEN });
      }

      const artifact: ArtifactFile = {
        ...scope,
        id: newArtifactId(),
        name,
        size,
        digest,
        expiresAt: expiryAfter({ retentionDays, nowMs }),
      };
      const dataKey = dataKeyOf(artifact);
      yield* (size >= MULTIPART_FROM_BYTES ? putInParts : putWhole)({
        key: dataKey,
        name,
        file,
        scope,
      }).pipe(Effect.tapError(() => deleteOrNote(dataKey)));

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
      const latest = yield* latestInRun({
        repositoryId: repositoryId.value,
        runId: runId === '' ? scope.runId : runId,
        names,
      });
      return latest
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
      retrying(
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
      const found = yield* findLive(id);
      if (Option.isNone(found)) return yield* new ClientError({ message: 'Not found' });
      const {
        artifact: { name, repositoryId },
        nameKey,
        dataKey,
      } = found.value;
      if (repositoryId !== scope.repositoryId) {
        return yield* new ClientError({ message: OTHER_REPOSITORY });
      }
      // The name first, which is the commit: anything left after it can't be found by any read.
      yield* retrying(deleteObject(nameKey));
      yield* retrying(deleteObject(dataKey)).pipe(
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
