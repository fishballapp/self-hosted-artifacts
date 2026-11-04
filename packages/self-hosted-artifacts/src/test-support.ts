import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Clock from 'effect/Clock';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import type * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import type * as Path from 'effect/Path';
import { type Config, type S3StoreConfig, ServerConfig } from './config.ts';
import { ArtifactServer, BucketArtifactServer, makeNodeServer } from './node-server.ts';
import { SigningKeysUnavailableError, TokenRejectedError, TokenVerifier } from './oidc.ts';
import { s3StoreLayer } from './s3-store.ts';
import { DiskStore } from './store.ts';
import type { RunScope } from './store-contract.ts';

export type Verification =
  | { kind: 'verified'; repository: string; scope: RunScope }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

/** A verifier that answers what a test says, for tests about what the server does with that. */
export const verifierAnswering = (answer: (token: string) => Promise<Verification>) => {
  const toOutcome = (
    verification: Verification,
  ): Effect.Effect<
    { readonly repository: string; readonly scope: RunScope },
    TokenRejectedError | SigningKeysUnavailableError
  > => {
    if (verification.kind === 'verified') {
      const { repository, scope } = verification;
      return Effect.succeed({ repository, scope });
    }
    return verification.kind === 'rejected'
      ? Effect.fail(new TokenRejectedError({ reason: verification.reason }))
      : Effect.fail(new SigningKeysUnavailableError({ reason: verification.reason }));
  };
  return Layer.succeed(
    TokenVerifier,
    TokenVerifier.of({
      verify: token => Effect.promise(() => answer(token)).pipe(Effect.flatMap(toOutcome)),
    }),
  );
};

/** A clock whose time a test sets, whose sleeps are real: requests run over a real socket. */
export const clockAt = (now: () => Temporal.Instant) => {
  const real = Clock.Clock.defaultValue();
  const millis = () => now().epochMilliseconds;
  const nanos = () => BigInt(millis()) * 1_000_000n;
  return Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: duration => real.sleep(duration),
  });
};

export const listenOnLoopback = async (server: Server): Promise<string> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

export const closeServer = async (server: Server) => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

/** The real server and store on a loopback socket; the verifier, clock and logger are the test's. */
export const startTestServer = async ({
  config,
  verifier,
  clock = Layer.empty,
  onLog = () => undefined,
  storeServices = NodeServices.layer,
}: {
  config: Config;
  verifier: Layer.Layer<TokenVerifier>;
  clock?: Layer.Layer<never>;
  onLog?: (line: string) => void;
  storeServices?: Layer.Layer<FileSystem.FileSystem | Path.Path>;
}) => {
  if (config.store.kind !== 'disk') throw new Error('startTestServer is for a disk');
  let nodeServer: Server | undefined;
  const makeServer = () => {
    nodeServer = makeNodeServer();
    return nodeServer;
  };
  const capturedLogs = Logger.layer([Logger.map(Logger.formatLogFmt, onLog)]);
  const configLayer = Layer.succeed(ServerConfig, config);
  const runtime = ManagedRuntime.make(
    ArtifactServer.pipe(
      Layer.provide(NodeHttpServer.layerServer(makeServer, { host: '127.0.0.1', port: 0 })),
      Layer.provideMerge(
        Layer.mergeAll(
          configLayer,
          verifier,
          DiskStore.layerWithStore(config.store).pipe(Layer.provide(storeServices)),
        ),
      ),
      Layer.provideMerge(clock),
      Layer.provideMerge(capturedLogs),
    ),
  );
  const store = await runtime.runPromise(Effect.service(DiskStore));
  if (nodeServer === undefined) throw new Error('The server did not start');
  const server = nodeServer;
  return {
    server,
    store,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    port: (server.address() as AddressInfo).port,
    stop: async () => {
      server.closeAllConnections();
      await runtime.dispose();
    },
  };
};

/** `startTestServer`, for a server in front of a bucket: its keys come in as they would from the environment. */
export const startBucketTestServer = async ({
  config,
  store,
  verifier,
  credentials,
  clock = Layer.empty,
  onLog = () => undefined,
}: {
  config: Config;
  store: S3StoreConfig;
  verifier: Layer.Layer<TokenVerifier>;
  credentials: Readonly<Record<string, string>>;
  clock?: Layer.Layer<never>;
  onLog?: (line: string) => void;
}) => {
  let nodeServer: Server | undefined;
  const runtime = ManagedRuntime.make(
    BucketArtifactServer.pipe(
      Layer.provide(
        NodeHttpServer.layerServer(
          () => {
            nodeServer = makeNodeServer();
            return nodeServer;
          },
          { host: '127.0.0.1', port: 0 },
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          verifier,
          s3StoreLayer(store).pipe(
            Layer.provide(
              Layer.mergeAll(
                // Fresh, or it's the one a test's verifier was given, whose `fetch` answers with keys.
                Layer.fresh(FetchHttpClient.layer),
                Layer.succeed(HttpClient.TracerPropagationEnabled, false),
                ConfigProvider.layer(ConfigProvider.fromUnknown(credentials)),
              ),
            ),
          ),
        ),
      ),
      Layer.provideMerge(clock),
      Layer.provideMerge(Logger.layer([Logger.map(Logger.formatLogFmt, onLog)])),
    ),
  );
  await runtime.runPromise(Effect.void);
  if (nodeServer === undefined) throw new Error('The server did not start');
  const server = nodeServer;
  return {
    port: (server.address() as AddressInfo).port,
    stop: async () => {
      server.closeAllConnections();
      await runtime.dispose();
    },
  };
};
