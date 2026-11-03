import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { Minimatch } from 'minimatch';

/** A pattern that can't be read, or a path that can't be. */
export class SearchError extends Schema.TaggedError<SearchError>()('SearchError', {
  message: Schema.String,
}) {}

// What follows is @actions/glob with the options actions/upload-artifact gives it, on POSIX paths, so
// a workflow's `path` finds the same files here.

type Pattern = {
  readonly source: string;
  readonly isNegated: boolean;
  /** A trailing slash: matches folders, not files. */
  readonly isDirectoryOnly: boolean;
  /** Added by `withDescendants`, so a folder's files follow it. */
  readonly isImplicit: boolean;
  /** The literal path before the first wildcard. */
  readonly searchPath: string;
  readonly minimatch: Minimatch;
};

const MINIMATCH_OPTIONS = {
  dot: true,
  nobrace: true,
  nocomment: true,
  noext: true,
  nonegate: true,
} as const;

const LITERAL_TOKENS =
  /\\(?<escaped>.)|(?<wildcard>[*?])|\[(?<set>(?:\\.|[^\]\\])*)\]|(?<plain>.)/gsu;

/** The segment without its glob syntax, or nothing if it really is a glob. */
const literalOf = (segment: string): string | undefined => {
  const literals = Array.from(segment.matchAll(LITERAL_TOKENS), ({ 0: token, groups }) => {
    if (groups?.wildcard !== undefined) return undefined;
    if (groups?.set === undefined) return groups?.escaped ?? groups?.plain;
    const set = groups.set.replaceAll(/\\(.)/gsu, '$1');
    if (set === '') return token;
    return set.length === 1 ? set : undefined;
  });
  return literals.includes(undefined) ? undefined : literals.join('');
};

export const globEscape = (path: string) =>
  path
    .replaceAll('\\', '\\\\')
    .replaceAll(/\[(?=[^/]+\])/gu, '[[]')
    .replaceAll('?', '[?]')
    .replaceAll('*', '[*]');

const toAbsolutePattern = (
  pattern: string,
  { cwd, home }: { readonly cwd: string; readonly home: string },
) => {
  if (pattern === '.' || pattern.startsWith('./')) return globEscape(cwd) + pattern.slice(1);
  if (pattern === '~' || pattern.startsWith('~/')) return globEscape(home) + pattern.slice(1);
  return pattern.startsWith('/') ? pattern : `${globEscape(cwd)}/${pattern}`;
};

const trimTrailingSlash = (path: string) =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

const parsePattern = (
  line: string,
  location: { readonly cwd: string; readonly home: string },
): Result.Result<Pattern, SearchError> => {
  const negations = /^(?:!\s*)*/u.exec(line)?.[0] ?? '';
  const written = line.slice(negations.length).replaceAll(/\/\/+/gu, '/');
  if (written === '') return Result.fail(new SearchError({ message: 'pattern cannot be empty' }));

  const hasRelativePathing = trimTrailingSlash(written)
    .split('/')
    .map(literalOf)
    .some((literal, index) => literal === '..' || (literal === '.' && index > 0));
  if (hasRelativePathing) {
    return Result.fail(
      new SearchError({
        message: `Invalid pattern '${written}'. Relative pathing '.' and '..' is not allowed.`,
      }),
    );
  }

  const absolute = toAbsolutePattern(written, location).replaceAll(/\/\/+/gu, '/');
  const source = trimTrailingSlash(absolute);
  const literals = source
    .split('/')
    .filter(segment => segment !== '')
    .map(literalOf);
  return Result.succeed({
    source,
    isNegated: negations.replaceAll(/\s/gu, '').length % 2 === 1,
    isDirectoryOnly: absolute.endsWith('/') && absolute !== '/',
    isImplicit: false,
    searchPath: `/${Arr.takeWhile(literals, literal => literal !== undefined).join('/')}`,
    minimatch: new Minimatch(source, MINIMATCH_OPTIONS),
  });
};

const endsInGlobstar = ({ source }: Pattern) => source.endsWith('/**');

const withDescendants = (pattern: Pattern): readonly Pattern[] => {
  if (!pattern.isDirectoryOnly && endsInGlobstar(pattern)) return [pattern];
  const source = `${pattern.source === '/' ? '' : pattern.source}/**`;
  return [
    pattern,
    {
      ...pattern,
      source,
      isDirectoryOnly: false,
      isImplicit: true,
      minimatch: new Minimatch(source, MINIMATCH_OPTIONS),
    },
  ];
};

/** Minimatch won't match `/foo/**` against `/foo` without a trailing slash, unless it was implied. */
const matches = (pattern: Pattern, item: string) =>
  pattern.minimatch.match(endsInGlobstar(pattern) && !pattern.isImplicit ? `${item}/` : item);

const mayMatchBelow = ({ minimatch }: Pattern, item: string) =>
  item === '/' || minimatch.matchOne(item.split('/'), minimatch.set[0] ?? [], true);

const isInside = (parent: string, path: string) =>
  path !== parent && path.startsWith(parent === '/' ? '/' : `${parent}/`);

/** Each pattern's search path, less duplicates and those inside another. */
const searchPathsOf = (patterns: readonly Pattern[]) => {
  const candidates = [
    ...new Set(patterns.filter(({ isNegated }) => !isNegated).map(p => p.searchPath)),
  ];
  return candidates.filter(path => !candidates.some(other => isInside(other, path)));
};

const commonAncestor = (paths: readonly string[]) => {
  const [first = [], ...rest] = paths.map(path => path.split('/'));
  const common = Arr.takeWhile(first, (segment, index) =>
    rest.every(other => other[index] === segment),
  );
  return common.join('/') || '/';
};

/**
 * The root is what's left off the front of every path in the zip: a lone file's folder, or with
 * several search paths their nearest common ancestor, or else the one search path.
 */
const rootDirectoryOf = (searchPaths: readonly string[], files: readonly string[]) => {
  const [file] = files;
  const isOneNamedFile =
    file !== undefined && files.length === 1 && searchPaths.length === 1 && searchPaths[0] === file;
  return isOneNamedFile ? dirname(file) : commonAncestor(searchPaths);
};

export const findFilesToUpload = Effect.fn('search.findFilesToUpload')(function* ({
  searchPath,
  includeHiddenFiles,
}: {
  searchPath: string;
  includeHiddenFiles: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const location = yield* Effect.sync(() => ({ cwd: process.cwd(), home: homedir() }));
  const written = yield* Effect.fromResult(
    Result.all(
      searchPath
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
        .map(line => parsePattern(line, location)),
    ),
  );
  const patterns = written.flatMap(withDescendants);

  const walk = (
    item: string,
    ancestors: ReadonlySet<string>,
  ): Effect.Effect<readonly string[], SearchError> =>
    Effect.gen(function* () {
      const matching = patterns.filter(pattern => matches(pattern, item));
      const isFolderMatch = matching.at(-1)?.isNegated === false;
      const isFileMatch = matching.findLast(p => !p.isDirectoryOnly)?.isNegated === false;
      const mayDescend =
        isFolderMatch ||
        isFileMatch ||
        patterns.some(pattern => !pattern.isNegated && mayMatchBelow(pattern, item));
      if (!mayDescend) return [];

      const unreadable = () => new SearchError({ message: `Can't read ${item}` });
      // A broken symlink, or something removed since the folder was read.
      const info = yield* fs.stat(item).pipe(
        Effect.asSome,
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
        Effect.mapError(unreadable),
      );
      if (Option.isNone(info)) return [];
      if (!includeHiddenFiles && basename(item).startsWith('.')) return [];
      // Reading a FIFO or a socket would never finish.
      if (info.value.type !== 'Directory') {
        return isFileMatch && info.value.type === 'File' ? [item] : [];
      }

      const realPath = yield* fs.realPath(item).pipe(Effect.mapError(unreadable));
      if (ancestors.has(realPath)) return [];
      const children = yield* fs.readDirectory(item).pipe(Effect.mapError(unreadable));
      const below = new Set([...ancestors, realPath]);
      const found = yield* Effect.forEach(
        children.toSorted().map(child => `${item === '/' ? '' : item}/${child}`),
        child => walk(child, below),
        { concurrency: 1 },
      );
      return found.flat();
    });

  const searchPaths = searchPathsOf(patterns);
  const files = (yield* Effect.forEach(searchPaths, path => walk(path, new Set()), {
    concurrency: 1,
  })).flat();
  return { files, rootDirectory: rootDirectoryOf(searchPaths, files) };
});
