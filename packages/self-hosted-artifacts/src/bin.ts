#!/usr/bin/env node
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as CliConfig from 'effect/cli/CliConfig';
import * as CliError from 'effect/cli/CliError';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import packageJson from '../package.json' with { type: 'json' };
import { deleteArtifact, list } from './artifacts.ts';
import { type ClientError, DEFAULT_AUDIENCE } from './client-support.ts';
import { type DiskStoreConfig, type S3StoreConfig, ServerConfig } from './config.ts';
import { DOWNLOAD_DEFAULTS, download } from './download.ts';
import { MERGE_DEFAULTS, merge } from './merge.ts';
import { ArtifactServer, BucketArtifactServer, makeNodeServer } from './node-server.ts';
import { TokenVerifier } from './oidc.ts';
import { s3StoreLayer } from './s3-store.ts';
import { DiskStore, StoreSweeps } from './store.ts';
import { type TargetInputs, targetLayer } from './target.ts';
import { UPLOAD_DEFAULTS, upload } from './upload.ts';

// launchd kills a daemon 20 seconds after SIGTERM, and a request stopped sooner can clean up.
const SHUTDOWN_GRACE = Duration.seconds(5);

const NodeServer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig;
    return NodeHttpServer.layerServer(makeNodeServer, {
      host,
      port,
      gracefulShutdownTimeout: SHUTDOWN_GRACE,
    });
  }),
);

// No trace headers on requests to GitHub or a bucket: neither has any use for them.
const OutgoingRequests = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

const DiskServer = (store: DiskStoreConfig) =>
  Layer.mergeAll(ArtifactServer, StoreSweeps).pipe(Layer.provide(DiskStore.layerWithStore(store)));

const BucketServer = (store: S3StoreConfig) =>
  BucketArtifactServer.pipe(Layer.provide(s3StoreLayer(store)), Layer.provide(OutgoingRequests));

const ConfiguredServer = Layer.unwrap(
  Effect.gen(function* () {
    const { store } = yield* ServerConfig;
    return store.kind === 'disk' ? DiskServer(store) : BucketServer(store);
  }),
);

const Main = ConfiguredServer.pipe(
  Layer.provide(NodeServer),
  Layer.provide(TokenVerifier.layer),
  Layer.provide(OutgoingRequests),
);

const serve = Command.make(
  'serve',
  { configPath: Flag.String('config').pipe(Flag.withDescription('The JSON config file')) },
  ({ configPath }) =>
    Layer.launch(Main).pipe(
      Effect.provide(ServerConfig.layerFromFile(configPath)),
      Effect.catchTags({
        ConfigError: error =>
          Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
        ServeError: error =>
          Effect.fail(
            new CliError.UserError({
              cause: error,
              userMessage: `Can't listen: ${error.message}`,
            }),
          ),
      }),
    ),
).pipe(Command.withDescription('Run the file server'));

const targetFlags = {
  serverUrl: Flag.String('server-url').pipe(
    Flag.withDescription("The server's base URL, as this machine reaches it. Or use --s3-bucket"),
    Flag.withDefault(''),
  ),
  audience: Flag.String('audience').pipe(
    Flag.withDescription('The OIDC audience to request, with --server-url'),
    Flag.withDefault(DEFAULT_AUDIENCE),
  ),
  s3Bucket: Flag.String('s3-bucket').pipe(
    Flag.withDescription('The bucket to use rather than a server'),
    Flag.withDefault(''),
  ),
  s3Region: Flag.String('s3-region').pipe(
    Flag.withDescription("The bucket's region, or AWS_REGION. On R2, `auto`"),
    Flag.withDefault(''),
  ),
  s3Endpoint: Flag.String('s3-endpoint').pipe(
    Flag.withDescription('The endpoint of an S3-compatible store, such as R2 or MinIO'),
    Flag.withDefault(''),
  ),
  s3LinkBase: Flag.String('s3-link-base').pipe(
    Flag.withDescription('What links start with, with --s3-bucket: where the bucket is public'),
    Flag.withDefault(''),
  ),
  scope: Flag.String('scope').pipe(
    Flag.withDescription(
      'With --s3-bucket outside GitHub Actions: <repository ID>/<run ID>/<run attempt>',
    ),
    Flag.withDefault(''),
  ),
};

const asClientCommand =
  (target: TargetInputs) =>
  <A, R>(self: Effect.Effect<A, ClientError, R>) =>
    self.pipe(
      Effect.provide(targetLayer(target)),
      Effect.catchTag('ClientError', (error: ClientError) =>
        Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
      ),
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(HttpClient.TracerPropagationEnabled, false),
        ),
      ),
    );

const uploadCommand = Command.make(
  'upload',
  {
    target: targetFlags,
    path: Flag.String('path').pipe(
      Flag.withDescription(
        'A file, folder or wildcard pattern to upload, or to exclude with a leading `!`. Repeat for several',
      ),
      Flag.atLeast(1),
    ),
    name: Flag.String('name').pipe(
      Flag.withDescription(
        `The name to store it under, plus \`.zip\`. With \`--archive false\`, the file's own name is used instead`,
      ),
      Flag.withDefault(UPLOAD_DEFAULTS.name),
    ),
    ifNoFilesFound: Flag.String('if-no-files-found').pipe(
      Flag.withDescription('With nothing to upload: warn, error or ignore'),
      Flag.withDefault(UPLOAD_DEFAULTS.ifNoFilesFound),
    ),
    retentionDays: Flag.String('retention-days').pipe(
      Flag.withDescription("Days to keep it. 0 means the target's default"),
      Flag.withDefault(UPLOAD_DEFAULTS.retentionDays),
    ),
    compressionLevel: Flag.String('compression-level').pipe(
      Flag.withDescription('Zlib compression level for the zip, 0 to 9'),
      Flag.withDefault(UPLOAD_DEFAULTS.compressionLevel),
    ),
    includeHiddenFiles: Flag.String('include-hidden-files').pipe(
      Flag.withDescription('true to include files and folders starting with a dot'),
      Flag.withDefault(UPLOAD_DEFAULTS.includeHiddenFiles),
    ),
    archive: Flag.String('archive').pipe(
      Flag.withDescription('false to upload one file as it is rather than zipped'),
      Flag.withDefault(UPLOAD_DEFAULTS.archive),
    ),
    overwrite: Flag.String('overwrite').pipe(
      Flag.withDescription('true to replace an artifact of this name in the same run attempt'),
      Flag.withDefault(UPLOAD_DEFAULTS.overwrite),
    ),
  },
  ({ target, path, ...inputs }) =>
    upload({ ...inputs, path: path.join('\n') }).pipe(
      Effect.flatMap(result =>
        result._tag === 'NoFilesFound'
          ? Console.error(result.isWarning ? `Warning: ${result.message}` : result.message)
          : Console.log(
              JSON.stringify({
                id: result.id,
                name: result.name,
                size: result.size,
                digest: result.digest,
                links: result.links,
                expiresAt: result.expiresAt,
              }),
            ),
      ),
      asClientCommand(target),
    ),
).pipe(Command.withDescription('Upload files'));

const repositoryFlag = Flag.String('repository').pipe(
  Flag.withDescription("Read from this owner/name. Defaults to the job's repository"),
  Flag.withDefault(''),
);
const runIdFlag = Flag.String('run-id').pipe(
  Flag.withDescription("Read from this run. Defaults to the job's run"),
  Flag.withDefault(''),
);
const artifactIdsFlag = Flag.String('artifact-ids').pipe(
  Flag.withDescription("The IDs to take, comma-separated. Can't go with --name"),
  Flag.withDefault(''),
);
const patternFlag = Flag.String('pattern').pipe(
  Flag.withDescription(
    'A glob the artifact names must match. Ignored with --name or --artifact-ids',
  ),
  Flag.withDefault(''),
);
const githubTokenFlag = Flag.String('github-token').pipe(
  Flag.withDescription('Accepted as actions/download-artifact has it, and ignored'),
  Flag.withDefault(''),
);

const warnOnStderr = (message: string) => Console.error(`Warning: ${message}`);

const downloadCommand = Command.make(
  'download',
  {
    target: targetFlags,
    name: Flag.String('name').pipe(
      Flag.withDescription('The artifact to download. Without it, every artifact in the run'),
      Flag.withDefault(''),
    ),
    artifactIds: artifactIdsFlag,
    path: Flag.String('path').pipe(
      Flag.withDescription('Where to put it. Defaults to $GITHUB_WORKSPACE, then this directory'),
      Flag.withDefault(''),
    ),
    pattern: patternFlag,
    mergeMultiple: Flag.String('merge-multiple').pipe(
      Flag.withDescription('true to put several artifacts in one folder rather than one each'),
      Flag.withDefault(DOWNLOAD_DEFAULTS.mergeMultiple),
    ),
    githubToken: githubTokenFlag,
    repository: repositoryFlag,
    runId: runIdFlag,
    skipDecompress: Flag.String('skip-decompress').pipe(
      Flag.withDescription('true to keep a zip as it is'),
      Flag.withDefault(DOWNLOAD_DEFAULTS.skipDecompress),
    ),
    digestMismatch: Flag.String('digest-mismatch').pipe(
      Flag.withDescription('With the wrong digest: ignore, info, warn or error'),
      Flag.withDefault(DOWNLOAD_DEFAULTS.digestMismatch),
    ),
  },
  ({ target, githubToken, ...inputs }) =>
    download({ ...inputs, isGithubTokenGiven: githubToken !== '', warn: warnOnStderr }).pipe(
      Effect.flatMap(result => Console.log(JSON.stringify(result))),
      asClientCommand(target),
    ),
).pipe(Command.withDescription('Download artifacts'));

const listCommand = Command.make(
  'list',
  {
    target: targetFlags,
    name: Flag.String('name').pipe(
      Flag.withDescription('Only the artifact of this name'),
      Flag.withDefault(''),
    ),
    artifactIds: artifactIdsFlag,
    pattern: patternFlag,
    githubToken: githubTokenFlag,
    repository: repositoryFlag,
    runId: runIdFlag,
  },
  ({ target, githubToken, ...inputs }) =>
    list({ ...inputs, isGithubTokenGiven: githubToken !== '', warn: warnOnStderr }).pipe(
      Effect.flatMap(artifacts => Console.log(JSON.stringify({ artifacts }))),
      asClientCommand(target),
    ),
).pipe(Command.withDescription("List a run's artifacts as JSON"));

const deleteCommand = Command.make(
  'delete',
  {
    target: targetFlags,
    name: Flag.String('name').pipe(
      Flag.withDescription('The artifact to delete, in the current run'),
      Flag.withDefault(''),
    ),
    artifactId: Flag.String('artifact-id').pipe(
      Flag.withDescription("The artifact to delete, in any of this job's repository's runs"),
      Flag.withDefault(''),
    ),
  },
  ({ target, ...inputs }) =>
    deleteArtifact(inputs).pipe(
      Effect.flatMap(deleted => Console.log(JSON.stringify(deleted))),
      asClientCommand(target),
    ),
).pipe(Command.withDescription("Delete one of a repository's artifacts"));

const mergeCommand = Command.make(
  'merge',
  {
    target: targetFlags,
    name: Flag.String('name').pipe(
      Flag.withDescription('The name to store the merged artifact under, plus `.zip`'),
      Flag.withDefault(MERGE_DEFAULTS.name),
    ),
    pattern: Flag.String('pattern').pipe(
      Flag.withDescription('A glob the names of the artifacts to merge must match'),
      Flag.withDefault(MERGE_DEFAULTS.pattern),
    ),
    separateDirectories: Flag.String('separate-directories').pipe(
      Flag.withDescription('true to put each artifact in a folder of its name'),
      Flag.withDefault(MERGE_DEFAULTS.separateDirectories),
    ),
    retentionDays: Flag.String('retention-days').pipe(
      Flag.withDescription("Days to keep it. 0 means the target's default"),
      Flag.withDefault(MERGE_DEFAULTS.retentionDays),
    ),
    compressionLevel: Flag.String('compression-level').pipe(
      Flag.withDescription('Zlib compression level for the zip, 0 to 9'),
      Flag.withDefault(MERGE_DEFAULTS.compressionLevel),
    ),
    deleteMerged: Flag.String('delete-merged').pipe(
      Flag.withDescription('true to delete the artifacts once they are merged'),
      Flag.withDefault(MERGE_DEFAULTS.deleteMerged),
    ),
    includeHiddenFiles: Flag.String('include-hidden-files').pipe(
      Flag.withDescription('true to include files and folders starting with a dot'),
      Flag.withDefault(MERGE_DEFAULTS.includeHiddenFiles),
    ),
  },
  ({ target, ...inputs }) =>
    merge({
      ...inputs,
      warn: warnOnStderr,
      // Before any original is deleted, so a failed delete still leaves the result.
      onMerged: ({ id, name, size, digest, links, expiresAt, merged }) =>
        Console.log(
          JSON.stringify({
            id,
            name,
            size,
            digest,
            links,
            expiresAt,
            merged: merged.map(artifact => ({ id: artifact.id, name: artifact.name })),
          }),
        ),
    }).pipe(asClientCommand(target)),
).pipe(
  Command.withDescription(
    "Merge a run's artifacts into one, as actions/upload-artifact/merge does",
  ),
);

const command = Command.make('self-hosted-artifacts').pipe(
  Command.withDescription('Artifacts for GitHub Actions on your own disk or bucket'),
  Command.withSubcommands([
    serve,
    uploadCommand,
    downloadCommand,
    listCommand,
    deleteCommand,
    mergeCommand,
  ]),
);

Command.run(command, { version: packageJson.version }).pipe(
  Effect.provide(
    Layer.mergeAll(
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      Logger.layer([Logger.consoleLogFmt]),
      NodeServices.layer,
    ),
  ),
  NodeRuntime.runMain,
);
