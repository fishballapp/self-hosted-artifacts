import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import { Minimatch } from 'minimatch';
import { ClientError } from './client-support.ts';
import { ARTIFACT_ID } from './protocol.ts';
import {
  connectToServer,
  deleteOnServer,
  type ListedArtifact,
  listOnServer,
  type ServerConnection,
} from './server-client.ts';

/** Says a thing that needs attention, in whatever way the action or the command does. */
export type Warn = (message: string) => Effect.Effect<void>;

/** A workflow moving over keeps its input, and shouldn't wonder why it made no difference. */
export const noteGithubTokenIgnored = Console.error(
  "github-token is ignored: the server takes the job's OIDC token, whichever repository or run is asked for",
);

/** The name it was uploaded under: a zip is stored as `<name>.zip`, a file under its own name. */
export const artifactNameOf = ({ name }: ListedArtifact) => name.replace(/\.zip$/iu, '');

export const parseRun = Effect.fnUntraced(function* ({
  repository,
  runId,
}: {
  repository: string;
  runId: string;
}) {
  const [owner, name, ...rest] = repository.split('/');
  if (repository !== '' && (!owner || !name || rest.length > 0)) {
    return yield* new ClientError({
      message: `Invalid repository: '${repository}'. Must be in format owner/repo`,
    });
  }
  if (runId !== '' && !/^[0-9]+$/u.test(runId)) {
    return yield* new ClientError({ message: `Invalid run-id: '${runId}'. Must be a number.` });
  }
  return { repository, runId };
});

const parseArtifactId = Effect.fnUntraced(function* (id: string) {
  if (!ARTIFACT_ID.test(id)) {
    return yield* new ClientError({
      message: `Invalid artifact ID: '${id}'. Must be an upload's artifact-id output.`,
    });
  }
  return id;
});

const parseArtifactIds = Effect.fnUntraced(function* (input: string) {
  const ids = input
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '');
  if (ids.length === 0) {
    return yield* new ClientError({
      message: "No valid artifact IDs provided in 'artifact-ids' input",
    });
  }
  return yield* Effect.forEach(ids, parseArtifactId, { concurrency: 1 });
});

/** A name means its zip if there is one, as most artifacts are, then a file of exactly that name. */
const findNamed = Effect.fnUntraced(function* ({
  connection,
  repository,
  runId,
  name,
}: {
  connection: ServerConnection;
  repository: string;
  runId: string;
  name: string;
}) {
  const zipName = `${name}.zip`;
  const found = yield* listOnServer({ connection, repository, runId, names: [zipName, name] });
  const artifact = found.find(listed => listed.name === zipName) ?? found[0];
  if (artifact === undefined) {
    return yield* new ClientError({ message: `Artifact '${name}' not found` });
  }
  return artifact;
});

const findByIds = Effect.fnUntraced(function* ({
  connection,
  repository,
  runId,
  artifactIds,
  warn,
}: {
  connection: ServerConnection;
  repository: string;
  runId: string;
  artifactIds: string;
  warn: Warn;
}) {
  const ids = yield* parseArtifactIds(artifactIds);
  const found = yield* listOnServer({ connection, repository, runId, ids });
  if (found.length === 0) {
    return yield* new ClientError({ message: 'None of the provided artifact IDs were found' });
  }
  const missing = ids.filter(id => !found.some(artifact => artifact.id === id));
  if (missing.length > 0) {
    yield* warn(`Could not find the following artifact IDs: ${missing.join(', ')}`);
  }
  return found;
});

/** What `name`, `artifact-ids` and `pattern` select, as actions/download-artifact has them. */
export const findArtifacts = Effect.fnUntraced(function* ({
  connection,
  name,
  artifactIds,
  pattern,
  repository,
  runId,
  warn,
}: {
  connection: ServerConnection;
  name: string;
  artifactIds: string;
  pattern: string;
  repository: string;
  runId: string;
  warn: Warn;
}) {
  if (name !== '' && artifactIds !== '') {
    return yield* new ClientError({
      message: "Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.",
    });
  }
  if (name !== '') return [yield* findNamed({ connection, repository, runId, name })];
  if (artifactIds !== '') {
    return yield* findByIds({ connection, repository, runId, artifactIds, warn });
  }
  const artifacts = yield* listOnServer({ connection, repository, runId });
  if (pattern === '') return artifacts;
  const matcher = new Minimatch(pattern);
  return artifacts.filter(artifact => matcher.match(artifactNameOf(artifact)));
});

/** Each artifact's latest in a run, narrowed as a download would narrow it. */
export const list = Effect.fn('artifacts.list')(function* ({
  serverUrl,
  audience,
  name,
  artifactIds,
  pattern,
  isGithubTokenGiven,
  warn,
  ...scope
}: {
  serverUrl: string;
  audience: string;
  name: string;
  artifactIds: string;
  pattern: string;
  isGithubTokenGiven: boolean;
  repository: string;
  runId: string;
  warn: Warn;
}) {
  const { repository, runId } = yield* parseRun(scope);
  if (isGithubTokenGiven) yield* noteGithubTokenIgnored;
  const connection = yield* connectToServer({ serverUrl, audience });
  return yield* findArtifacts({ connection, name, artifactIds, pattern, repository, runId, warn });
});

/** Removes one artifact of the token's repository: by ID in any run, or by name in the current one. */
export const deleteArtifact = Effect.fn('artifacts.deleteArtifact')(function* ({
  serverUrl,
  audience,
  name,
  artifactId,
}: {
  serverUrl: string;
  audience: string;
  name: string;
  artifactId: string;
}) {
  if ((name === '') === (artifactId === '')) {
    return yield* new ClientError({ message: 'Give one of --name and --artifact-id' });
  }
  if (artifactId !== '') yield* parseArtifactId(artifactId);
  const connection = yield* connectToServer({ serverUrl, audience });
  const id =
    artifactId !== ''
      ? artifactId
      : (yield* findNamed({ connection, repository: '', runId: '', name })).id;
  return yield* deleteOnServer({ connection, id });
});
