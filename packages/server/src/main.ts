import { type Config, ConfigError, readConfig } from './config.ts';
import { describeError, type Log } from './log.ts';
import { createTokenVerifier, fetchGitHubJwks } from './oidc.ts';
import { createArtifactServer } from './server.ts';
import { createStore } from './store.ts';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const config = ((): Config => {
  try {
    return readConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
})();

const now = () => Temporal.Now.instant();
const log: Log = line => process.stdout.write(`${now()} ${line}\n`);
const store = createStore({ dir: config.storeDir, now });

const sweep = async () => {
  try {
    const { removedArtifacts, removedTemps } = await store.sweep();
    log(`sweep removedArtifacts=${removedArtifacts} removedTemps=${removedTemps}`);
  } catch (error) {
    log(`sweep failed reason="${describeError(error)}"`);
  }
};

await sweep();
setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();

const server = createArtifactServer({
  config,
  store,
  verifyToken: createTokenVerifier({
    audience: config.oidcAudience,
    repositoryOwnerId: config.oidcRepositoryOwnerId,
    fetchJwks: fetchGitHubJwks,
    now,
  }),
  log,
});
server.listen(config.port, config.host, () => {
  log(`listening on ${JSON.stringify(server.address())}`);
});
