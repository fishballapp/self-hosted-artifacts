import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import { inputOr, provideTarget, runAction, warnInWorkflow } from './action-support.ts';
import { MERGE_DEFAULTS, merge } from './merge.ts';

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* merge({
    name: yield* inputOr('name', MERGE_DEFAULTS.name),
    pattern: yield* inputOr('pattern', MERGE_DEFAULTS.pattern),
    separateDirectories: yield* inputOr('separate-directories', MERGE_DEFAULTS.separateDirectories),
    retentionDays: yield* inputOr('retention-days', MERGE_DEFAULTS.retentionDays),
    compressionLevel: yield* inputOr('compression-level', MERGE_DEFAULTS.compressionLevel),
    deleteMerged: yield* inputOr('delete-merged', MERGE_DEFAULTS.deleteMerged),
    includeHiddenFiles: yield* inputOr('include-hidden-files', MERGE_DEFAULTS.includeHiddenFiles),
    warn: warnInWorkflow,
    // Before any original is deleted, so a failed delete leaves the step its outputs.
    onMerged: Effect.fnUntraced(function* ({ id, artifactUrl, digest, links, expiresAt }) {
      yield* fs.writeFileString(
        yield* Config.String('GITHUB_OUTPUT'),
        [
          `artifact-id=${id}`,
          `artifact-url=${artifactUrl}`,
          `artifact-digest=${digest}`,
          `links=${JSON.stringify(links)}`,
          `expires-at=${expiresAt}\n`,
        ].join('\n'),
        { flag: 'a' },
      );
    }),
  });
});

runAction(provideTarget(main));
