import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { type Config, ServerConfig } from './config.ts';
import { SigningKeysUnavailableError, TokenRejectedError, TokenVerifier } from './oidc.ts';
import { ArtifactServer, makeNodeServer } from './server.ts';
import { Store } from './store.ts';

export type Verification =
  | { kind: 'verified'; repository: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

/** A verifier that answers what a test says, for tests about what the server does with that. */
export const verifierAnswering = (answer: (token: string) => Promise<Verification>) => {
  const toOutcome = (
    verification: Verification,
  ): Effect.Effect<
    { readonly repository: string },
    TokenRejectedError | SigningKeysUnavailableError
  > => {
    if (verification.kind === 'verified') {
      return Effect.succeed({ repository: verification.repository });
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

/** The real server and store on a loopback socket; the verifier, clock and logger are the test's. */
export const startTestServer = async ({
  config,
  verifier,
  clock = Layer.empty,
  onLog = () => undefined,
}: {
  config: Config;
  verifier: Layer.Layer<TokenVerifier>;
  clock?: Layer.Layer<never>;
  onLog?: (line: string) => void;
}) => {
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
          Store.layer.pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer)),
        ),
      ),
      Layer.provideMerge(clock),
      Layer.provideMerge(capturedLogs),
    ),
  );
  const store = await runtime.runPromise(Effect.service(Store));
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
