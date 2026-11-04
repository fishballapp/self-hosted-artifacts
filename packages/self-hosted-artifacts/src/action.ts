import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import {
  inputOr,
  logLinks,
  provideTarget,
  requiredInput,
  runAction,
  warnInWorkflow,
} from './action-support.ts';
import { UPLOAD_DEFAULTS, upload } from './upload.ts';

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* upload({
    path: yield* requiredInput('path'),
    name: yield* inputOr('name', UPLOAD_DEFAULTS.name),
    ifNoFilesFound: yield* inputOr('if-no-files-found', UPLOAD_DEFAULTS.ifNoFilesFound),
    retentionDays: yield* inputOr('retention-days', UPLOAD_DEFAULTS.retentionDays),
    compressionLevel: yield* inputOr('compression-level', UPLOAD_DEFAULTS.compressionLevel),
    includeHiddenFiles: yield* inputOr('include-hidden-files', UPLOAD_DEFAULTS.includeHiddenFiles),
    archive: yield* inputOr('archive', UPLOAD_DEFAULTS.archive),
    overwrite: yield* inputOr('overwrite', UPLOAD_DEFAULTS.overwrite),
  });
  if (result._tag === 'NoFilesFound') {
    return yield* result.isWarning ? warnInWorkflow(result.message) : Console.log(result.message);
  }
  const { id, name, size, digest, artifactUrl, links, expiresAt } = result;
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
  yield* logLinks(links);
  return yield* Console.log(`Uploaded ${name} (${size} bytes), expires at ${expiresAt}`);
});

runAction(provideTarget(main));
