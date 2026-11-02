#!/usr/bin/env node
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
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

const command = Command.make(
  'self-hosted-artifacts',
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
).pipe(Command.withDescription('A small file server for builds from private repositories'));

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
