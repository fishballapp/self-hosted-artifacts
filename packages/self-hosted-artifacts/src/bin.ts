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
import { ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { ArtifactServer, makeNodeServer } from './server.ts';
import { Store, StoreSweeps } from './store.ts';
import { UPLOAD_DEFAULTS, type UploadError, upload } from './upload.ts';

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

const Main = Layer.mergeAll(ArtifactServer, StoreSweeps).pipe(
  Layer.provide(NodeServer),
  Layer.provide(Layer.mergeAll(Store.layer, TokenVerifier.layer)),
  Layer.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      // No trace headers on requests to GitHub: it has no use for them.
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
    ),
  ),
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

const uploadCommand = Command.make(
  'upload',
  {
    serverUrl: Flag.String('server-url').pipe(Flag.withDescription("The server's base URL")),
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
      Flag.withDescription("Days to keep it. 0 means the server's default"),
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
    audience: Flag.String('audience').pipe(
      Flag.withDescription('The OIDC audience to request'),
      Flag.withDefault(UPLOAD_DEFAULTS.audience),
    ),
  },
  ({ path, ...inputs }) =>
    upload({ ...inputs, path: path.join('\n') }).pipe(
      Effect.flatMap(result =>
        result._tag === 'NoFilesFound'
          ? Console.error(result.isWarning ? `Warning: ${result.message}` : result.message)
          : Console.log(
              JSON.stringify({
                name: result.name,
                size: result.size,
                links: result.links,
                expiresAt: result.expiresAt,
              }),
            ),
      ),
      Effect.catchTag('UploadError', (error: UploadError) =>
        Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
      ),
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(HttpClient.TracerPropagationEnabled, false),
        ),
      ),
    ),
).pipe(Command.withDescription('Upload files from a GitHub Actions job'));

const command = Command.make('self-hosted-artifacts').pipe(
  Command.withDescription('A small file server for builds from private repositories'),
  Command.withSubcommands([serve, uploadCommand]),
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
