import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { findFilesToUpload } from './search.ts';
import { zipFiles } from './zip.ts';

const ATTEMPTS = 4;
const TOKEN_REQUEST_TIMEOUT = Duration.seconds(30);

/** Why the upload didn't happen, after any retries. */
export class UploadError extends Schema.TaggedError<UploadError>()('UploadError', {
  message: Schema.String,
}) {}

class UploadUnavailableError extends Schema.TaggedError<UploadUnavailableError>()(
  'UploadUnavailableError',
  {
    message: Schema.String,
  },
) {}

// A line break in a value the action writes to its outputs would add an output of the server's
// choosing.
const SingleLineSchema = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/u));

const StoredSchema = Schema.Struct({
  expiresAt: SingleLineSchema,
  links: Schema.Record(Schema.String, SingleLineSchema),
});

const FailureSchema = Schema.Struct({ error: Schema.String });
const TokenSchema = Schema.Struct({ value: Schema.String });

const isOk = ({ status }: HttpClientResponse.HttpClientResponse) => status >= 200 && status < 300;

const readFailure = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const message = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FailureSchema)),
    Effect.map(({ error }) => error),
    Effect.orElseSucceed(() => `HTTP ${response.status}`),
  );
  return response.status >= 500
    ? new UploadUnavailableError({ message })
    : new UploadError({ message });
});

const describeCause = (cause: unknown): string => {
  if (!Predicate.isError(cause)) return String(cause);
  return Predicate.isError(cause.cause)
    ? `${cause.message}: ${cause.cause.message}`
    : cause.message;
};

const unavailableFrom = ({ reason }: HttpClientError.HttpClientError) =>
  new UploadUnavailableError({
    message: 'cause' in reason ? describeCause(reason.cause) : reason.message,
  });

const mintToken = Effect.fnUntraced(function* ({
  url,
  token,
}: {
  url: URL;
  token: Redacted.Redacted;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(url, {
      headers: { Authorization: `Bearer ${Redacted.value(token)}`, Accept: 'application/json' },
    })
    .pipe(
      Effect.mapError(unavailableFrom),
      Effect.timeoutOrElse({
        duration: TOKEN_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new UploadUnavailableError({ message: 'The OIDC token request timed out' })),
      }),
    );
  if (!isOk(response)) return yield* yield* readFailure(response);
  const { value } = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenSchema)),
    Effect.mapError(() => new UploadUnavailableError({ message: 'The runner sent no OIDC token' })),
  );
  return Redacted.make(value);
});

const readTokenRequest = Effect.gen(function* () {
  const url = yield* Config.String('ACTIONS_ID_TOKEN_REQUEST_URL').pipe(Config.option);
  const token = yield* Config.Redacted('ACTIONS_ID_TOKEN_REQUEST_TOKEN').pipe(Config.option);
  if (Option.isNone(url) || Option.isNone(token) || url.value === '') {
    return yield* new UploadError({
      message:
        'No OIDC token available: the server only accepts uploads from a GitHub Actions job with `permissions: id-token: write`',
    });
  }
  return { url: new URL(url.value), token: token.value };
}).pipe(Effect.catchTag('ConfigError', Effect.die));

/** Without both, `fetch` keeps the whole body in memory to replay it on a redirect. */
const STREAMING_REQUEST_INIT = { redirect: 'error', window: null } as const;

/** The server-specific part: a token for each attempt, and the one route that stores a file. */
const sendToServer = Effect.fnUntraced(function* ({
  serverUrl,
  audience,
  tokenRequest,
  file,
  name,
  retentionDays,
}: {
  serverUrl: string;
  audience: string;
  tokenRequest: { url: URL; token: Redacted.Redacted };
  file: Blob;
  name: string;
  retentionDays: number;
}) {
  const client = yield* HttpClient.HttpClient;
  // The runner's URL already has a query string, so the audience has to join it.
  tokenRequest.url.searchParams.set('audience', audience);
  const base = serverUrl.replace(/\/+$/u, '');

  const attempt = Effect.gen(function* () {
    const token = yield* mintToken(tokenRequest);
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${base}/artifacts`).pipe(
          HttpClientRequest.setUrlParams({
            name,
            // The server takes no `0`: leaving it out asks for its default.
            ...(retentionDays === 0 ? {} : { 'retention-days': String(retentionDays) }),
          }),
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setBody(
            HttpBody.raw(file, { contentType: 'application/octet-stream' }),
          ),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, STREAMING_REQUEST_INIT),
        Effect.mapError(unavailableFrom),
      );
    if (!isOk(response)) return yield* yield* readFailure(response);
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StoredSchema)),
      Effect.mapError(() => new UploadError({ message: `${base} answered without a usable link` })),
    );
  });

  const { expiresAt, links } = yield* attempt.pipe(
    Effect.retry({
      while: Predicate.isTagged('UploadUnavailableError'),
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.while(({ attempt: failed }) => failed < ATTEMPTS),
        Schedule.tap(({ attempt: failed, duration, input }) =>
          Console.error(
            `Attempt ${failed} failed (${
              // A line of the server's choosing could otherwise start a workflow command.
              Predicate.isTagged(input, 'UploadUnavailableError')
                ? input.message.replaceAll(/[\r\n]+/gu, ' ')
                : 'unknown'
            }), retrying in ${Duration.toSeconds(duration)}s`,
          ),
        ),
      ),
    }),
    Effect.catchTag('UploadUnavailableError', ({ message }) =>
      Effect.fail(new UploadError({ message })),
    ),
  );

  const artifactUrl = Object.values(links)[0];
  if (artifactUrl === undefined) {
    return yield* new UploadError({ message: `${base} answered without a usable link` });
  }
  return { artifactUrl, links, expiresAt };
});

const openFile = Effect.fnUntraced(function* ({ path, name }: { path: string; name: string }) {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = () => new UploadError({ message: `Can't read ${path}` });
  const { size } = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
  const file = yield* Effect.tryPromise({ try: () => openAsBlob(path), catch: unreadable });
  // Node keeps this Blob's size in 32 bits, and fetch would send it as the Content-Length.
  if (file.size !== Number(size)) {
    return yield* new UploadError({
      message: `${name} is ${size} bytes, and Node can't upload 4 GiB or more`,
    });
  }
  return file;
});

/** The same in the action's inputs and the command's flags, as actions/upload-artifact has them. */
export const UPLOAD_DEFAULTS = {
  name: 'artifact',
  ifNoFilesFound: 'warn',
  retentionDays: '0',
  compressionLevel: '6',
  includeHiddenFiles: 'false',
  archive: 'true',
  audience: 'self-hosted-artifacts',
} as const;

const BooleanInputSchema = Schema.Literals(['true', 'True', 'TRUE', 'false', 'False', 'FALSE']);
const IfNoFilesFoundSchema = Schema.Literals(['warn', 'error', 'ignore']);

const parseBooleanInput = Effect.fnUntraced(function* (name: string, value: string) {
  if (!Schema.is(BooleanInputSchema)(value)) {
    return yield* new UploadError({
      message: `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\nSupport boolean input list: \`true | True | TRUE | false | False | FALSE\``,
    });
  }
  return value.toLowerCase() === 'true';
});

const parseIfNoFilesFound = Effect.fnUntraced(function* (value: string) {
  if (!Schema.is(IfNoFilesFoundSchema)(value)) {
    return yield* new UploadError({
      message: `Unrecognized if-no-files-found input. Provided: ${value}. Available options: ${IfNoFilesFoundSchema.literals.join(',')}`,
    });
  }
  return value;
});

const parseRetentionDays = Effect.fnUntraced(function* (value: string) {
  const days = Number.parseInt(value, 10);
  if (Number.isNaN(days)) return yield* new UploadError({ message: 'Invalid retention-days' });
  return days;
});

const parseCompressionLevel = Effect.fnUntraced(function* (value: string) {
  const level = Number.parseInt(value, 10);
  if (Number.isNaN(level)) return yield* new UploadError({ message: 'Invalid compression-level' });
  if (level < 0 || level > 9) {
    return yield* new UploadError({
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
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* Config.String('RUNNER_TEMP').pipe(
    Config.withDefault(undefined),
    Effect.catchTag('ConfigError', Effect.die),
  );
  const target = yield* fs
    .makeTempFileScoped({ directory, prefix: 'self-hosted-artifacts-', suffix: '.zip' })
    .pipe(
      Effect.mapError(
        () =>
          new UploadError({
            message: `Can't create a temporary file in ${directory ?? 'the system temp folder'}`,
          }),
      ),
    );
  yield* zipFiles({ files, rootDirectory, compressionLevel, target }).pipe(
    Effect.mapError(({ message }) => new UploadError({ message })),
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
    audience: string;
  }) {
    const includeHiddenFiles = yield* parseBooleanInput(
      'include-hidden-files',
      inputs.includeHiddenFiles,
    );
    const archive = yield* parseBooleanInput('archive', inputs.archive);
    const ifNoFilesFound = yield* parseIfNoFilesFound(inputs.ifNoFilesFound);
    const retentionDays = yield* parseRetentionDays(inputs.retentionDays);
    const compressionLevel = yield* parseCompressionLevel(inputs.compressionLevel);

    const { files, rootDirectory } = yield* findFilesToUpload({
      searchPath: inputs.path,
      includeHiddenFiles,
    }).pipe(Effect.mapError(({ message }) => new UploadError({ message })));

    const [firstFile] = files;
    if (firstFile === undefined) {
      const message = `No files were found with the provided path: ${inputs.path}. No artifacts will be uploaded.`;
      if (ifNoFilesFound === 'error') return yield* new UploadError({ message });
      return { _tag: 'NoFilesFound', message, isWarning: ifNoFilesFound === 'warn' } as const;
    }
    yield* Console.error(
      `With the provided path, there will be ${files.length} file${files.length === 1 ? '' : 's'} uploaded`,
    );
    if (!archive && files.length > 1) {
      return yield* new UploadError({
        message: `When 'archive' is set to false, only a single file can be uploaded. Found ${files.length} files to upload.`,
      });
    }

    // Before the zip, so a job without the permission finds out without waiting for it.
    const tokenRequest = yield* readTokenRequest;
    const filePath = archive
      ? yield* zipToTempFile({ files, rootDirectory, compressionLevel })
      : firstFile;
    const name = archive ? `${inputs.name}.zip` : basename(firstFile);
    const file = yield* openFile({ path: filePath, name });
    const stored = yield* sendToServer({
      serverUrl: inputs.serverUrl,
      audience: inputs.audience,
      tokenRequest,
      file,
      name,
      retentionDays,
    });
    return { _tag: 'Uploaded', name, size: file.size, ...stored } as const;
  },
  // Holds the zip until the last retry is over, and removes it however the upload ends.
  Effect.scoped,
);
