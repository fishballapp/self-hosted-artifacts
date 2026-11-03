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
import * as Option from 'effect/Option';
import packageJson from '../package.json' with { type: 'json' };
import { ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { ArtifactServer, makeNodeServer } from './server.ts';
import { Store, StoreSweeps } from './store.ts';
import { type UploadError, upload } from './upload.ts';

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
    path: Flag.String('path').pipe(Flag.withDescription('The one file to upload')),
    name: Flag.String('name').pipe(
      Flag.withDescription("The name to store it under. Defaults to the path's basename"),
      Flag.optional,
    ),
    retentionDays: Flag.String('retention-days').pipe(
      Flag.withDescription("Days to keep the file. Defaults to the server's default"),
      Flag.optional,
    ),
    audience: Flag.String('audience').pipe(
      Flag.withDescription('The OIDC audience to request'),
      Flag.withDefault('self-hosted-artifacts'),
    ),
  },
  ({ serverUrl, path, name, retentionDays, audience }) =>
    upload({
      serverUrl,
      path,
      name: Option.getOrUndefined(name),
      retentionDays: Option.getOrUndefined(retentionDays),
      audience,
    }).pipe(
      Effect.flatMap(({ name: storedName, size, links, expiresAt }) =>
        Console.log(JSON.stringify({ name: storedName, size, links, expiresAt })),
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
).pipe(Command.withDescription('Upload one file from a GitHub Actions job'));

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
