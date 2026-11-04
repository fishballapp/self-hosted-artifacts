import { env } from 'cloudflare:workers';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as Predicate from 'effect/Predicate';
import type * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import { ConfigError, parseConfig, ServerConfig } from './config.ts';
import { TokenVerifier } from './oidc.ts';
import { s3StoreLayer } from './s3-store.ts';
import { ArtifactRoutes, ResponseBreaker, respondJson } from './server.ts';

// A server in front of a bucket, as a Worker's `fetch`. Only a stream's response could need breaking,
// and a bucket's store has none.

const CONFIG_VARIABLE = 'SELF_HOSTED_ARTIFACTS_CONFIG';

const toIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** By setting alone, as this answers anyone who asks, and Schema's and JSON's messages quote values. */
const invalidConfig = ({ issue }: Schema.SchemaError) => {
  const settings = toIssues(issue)
    .issues.map(({ path = [] }) => path.join('.'))
    .filter(setting => setting !== '');
  return new ConfigError({
    message:
      settings.length === 0
        ? `${CONFIG_VARIABLE} has to be the server's config, as JSON`
        : `${CONFIG_VARIABLE} is invalid at ${settings.join(', ')}`,
  });
};

const BucketRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const value = env[CONFIG_VARIABLE];
    if (value === undefined) {
      return yield* new ConfigError({ message: `${CONFIG_VARIABLE} isn't set` });
    }
    // A string, or an object, which is how `wrangler.jsonc` can write it.
    const config = yield* parseConfig(
      Predicate.isString(value) ? value : JSON.stringify(value),
    ).pipe(Effect.mapError(invalidConfig));
    if (config.store.kind !== 's3') {
      return yield* new ConfigError({
        message: `${CONFIG_VARIABLE} has to have an "s3" store, as a Worker has no disk`,
      });
    }
    return ArtifactRoutes.pipe(
      Layer.provide(
        Layer.mergeAll(
          s3StoreLayer(config.store),
          TokenVerifier.layer,
          Layer.succeed(ResponseBreaker, { breakResponse: () => Effect.void }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    );
  }),
);

/** Every request, as nothing else can tell whoever deployed this, and a Worker can't refuse to start. */
const Misconfigured = ({ message }: ConfigError) =>
  HttpRouter.add(
    '*',
    '*',
    Effect.logError(message).pipe(Effect.as(respondJson(500, { error: message }))),
  );

/**
 * workerd throws on `redirect: 'error'`, which every request to a bucket asks for. With `manual`, a
 * redirect is an answer that isn't `ok`, so it fails the same way.
 */
const fetchOnWorkerd: typeof fetch = (input, init) =>
  fetch(input, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init);

// Built as the module loads, so no request can be left waiting on another's build. This does no I/O,
// which a Worker's global scope doesn't allow.
const { handler } = HttpRouter.toWebHandler(
  BucketRoutes.pipe(
    Layer.catch(Misconfigured),
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(FetchHttpClient.Fetch, fetchOnWorkerd),
            // No trace headers on requests to GitHub or a bucket: neither has any use for them.
            Layer.succeed(HttpClient.TracerPropagationEnabled, false),
          ),
        ),
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(Logger.layer([Logger.consoleJson])),
  ),
  // Effect's request logger logs the URL, which holds a full download token.
  { disableLogger: true },
);

export default {
  // Not `fetch: handler`: its second argument is an Effect `Context`, not the Worker's `env`.
  fetch: (request: Request) => handler(request),
};
