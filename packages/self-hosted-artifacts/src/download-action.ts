import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import { input, inputOr, requiredInput, runAction, warnInWorkflow } from './action-support.ts';
import { DOWNLOAD_DEFAULTS, download } from './download.ts';

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { downloadPath, artifacts } = yield* download({
    serverUrl: yield* requiredInput('server-url'),
    name: yield* input('name'),
    artifactIds: yield* input('artifact-ids'),
    path: yield* input('path'),
    pattern: yield* input('pattern'),
    mergeMultiple: yield* inputOr('merge-multiple', DOWNLOAD_DEFAULTS.mergeMultiple),
    isGithubTokenGiven: (yield* input('github-token')) !== '',
    repository: yield* input('repository'),
    runId: yield* input('run-id'),
    skipDecompress: yield* inputOr('skip-decompress', DOWNLOAD_DEFAULTS.skipDecompress),
    digestMismatch: yield* inputOr('digest-mismatch', DOWNLOAD_DEFAULTS.digestMismatch),
    audience: yield* inputOr('audience', DOWNLOAD_DEFAULTS.audience),
    warn: warnInWorkflow,
  });
  yield* fs.writeFileString(
    yield* Config.String('GITHUB_OUTPUT'),
    `download-path=${downloadPath}\n`,
    { flag: 'a' },
  );
  yield* Console.log(`Total of ${artifacts.length} artifact(s) downloaded`);
  return yield* Console.log('Download artifact has finished successfully');
});

runAction(main, { failurePrefix: 'Unable to download artifact(s): ' });
