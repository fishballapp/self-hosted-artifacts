import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { findFilesToUpload } from './search.ts';

// The tree and the cases are actions/upload-artifact's own __tests__/search.test.ts, to keep to its
// behaviour. Relative paths are covered in action.test.ts, which picks its working directory.
const FILES = [
  'folder-a/folder-b/folder-c/search-item1.txt',
  'folder-a/folder-b/folder-c/extraSearch-item1.txt',
  'folder-a/folder-b/folder-c/extra-file-in-folder-c.txt',
  'folder-d/search-item2.txt',
  'folder-d/search-item3.txt',
  'folder-d/search-item4.txt',
  'folder-d/extraSearch-item2.txt',
  'folder-f/extraSearch-item3.txt',
  'folder-h/amazing-item.txt',
  'folder-h/folder-i/extraSearch-item4.txt',
  'folder-h/folder-i/extraSearch-item5.txt',
  'folder-h/folder-j/folder-k/lonely-file.txt',
  'search-item5.txt',
  '.hidden-file.txt',
  '.hidden-folder/folder-in-hidden-folder/file.txt',
  'folder-a/.hidden-folder-in-folder-a/file.txt',
  'with[brackets]/in-brackets.txt',
];

describe('findFilesToUpload', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-search-'));
    for (const file of FILES) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), file);
    }
    await mkdir(join(root, 'folder-g'));
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  const find = (lines: readonly string[], includeHiddenFiles = false) =>
    findFilesToUpload({
      searchPath: lines.map(line => line.replaceAll('<root>', root)).join('\n'),
      includeHiddenFiles,
    }).pipe(
      Effect.map(({ files, rootDirectory }) => ({
        files: files.map(file => file.replace(`${root}/`, '')).toSorted(),
        rootDirectory: rootDirectory.replace(root, '<root>'),
      })),
      Effect.provide(NodeServices.layer),
    );

  it.effect('takes a lone file, with its folder as the root', () =>
    Effect.gen(function* () {
      expect(yield* find(['<root>/folder-a/folder-b/folder-c/extra-file-in-folder-c.txt'])).toEqual(
        {
          files: ['folder-a/folder-b/folder-c/extra-file-in-folder-c.txt'],
          rootDirectory: '<root>/folder-a/folder-b/folder-c',
        },
      );
    }),
  );

  it.effect('roots one file found by a wildcard at the path before the wildcard', () =>
    Effect.gen(function* () {
      expect(yield* find(['<root>/folder-h/**/*lonely*'])).toEqual({
        files: ['folder-h/folder-j/folder-k/lonely-file.txt'],
        rootDirectory: '<root>/folder-h',
      });
    }),
  );

  it.effect('roots one file found in a folder at that folder', () =>
    Effect.gen(function* () {
      expect(yield* find(['<root>/folder-h/folder-j'])).toEqual({
        files: ['folder-h/folder-j/folder-k/lonely-file.txt'],
        rootDirectory: '<root>/folder-h/folder-j',
      });
    }),
  );

  it.effect('takes a folder, hidden files aside', () =>
    Effect.gen(function* () {
      const { files, rootDirectory } = yield* find(['<root>/folder-h']);
      expect(files).toHaveLength(4);
      expect(rootDirectory).toBe('<root>/folder-h');
      expect((yield* find(['<root>/folder-h/'])).files).toEqual(files);
    }),
  );

  it.effect('takes a wildcard', () =>
    Effect.gen(function* () {
      const { files, rootDirectory } = yield* find(['<root>/**/*[Ss]earch*']);
      expect(files).toHaveLength(10);
      expect(rootDirectory).toBe('<root>');
    }),
  );

  it.effect('roots several paths at their nearest common ancestor', () =>
    Effect.gen(function* () {
      const { files, rootDirectory } = yield* find(['<root>/folder-a', '<root>/folder-d']);
      expect(files).toHaveLength(7);
      expect(rootDirectory).toBe('<root>');

      const below = yield* find([
        '<root>/folder-h/folder-i',
        '<root>/folder-h/folder-j/folder-k',
        '<root>/folder-h/amazing-item.txt',
      ]);
      expect(below.files).toHaveLength(4);
      expect(below.rootDirectory).toBe('<root>/folder-h');
    }),
  );

  it.effect('leaves out what a `!` line excludes, without changing the root', () =>
    Effect.gen(function* () {
      const { files, rootDirectory } = yield* find([
        '<root>/folder-a',
        '<root>/folder-d',
        '!<root>/folder-a/folder-b/**/extra*.txt',
      ]);
      expect(files).toEqual([
        'folder-a/folder-b/folder-c/search-item1.txt',
        'folder-d/extraSearch-item2.txt',
        'folder-d/search-item2.txt',
        'folder-d/search-item3.txt',
        'folder-d/search-item4.txt',
      ]);
      expect(rootDirectory).toBe('<root>');
    }),
  );

  it.effect('lets a later line win over an earlier one', () =>
    Effect.gen(function* () {
      const { files } = yield* find([
        '<root>/folder-d/*',
        '!<root>/folder-d/*',
        '<root>/folder-d/search-item2.txt',
      ]);
      expect(files).toEqual(['folder-d/search-item2.txt']);
    }),
  );

  it.effect('reads `!!` as a double negation, and skips comments and blank lines', () =>
    Effect.gen(function* () {
      const { files } = yield* find(['# a comment', '', '!!<root>/folder-f', '  ']);
      expect(files).toEqual(['folder-f/extraSearch-item3.txt']);
    }),
  );

  it.effect('leaves hidden files out, unless asked, even when named', () =>
    Effect.gen(function* () {
      const hidden = [
        '.hidden-file.txt',
        '.hidden-folder/folder-in-hidden-folder/file.txt',
        'folder-a/.hidden-folder-in-folder-a/file.txt',
      ];
      const { files } = yield* find(['<root>/**/*']);
      expect(files.filter(file => hidden.includes(file))).toEqual([]);
      expect(yield* find(['<root>/.hidden-file.txt'])).toMatchObject({ files: [] });
      expect(yield* find(['<root>/.hidden-folder'])).toMatchObject({ files: [] });
      // Only what the walk visits counts, so a path starting inside a hidden folder still works.
      expect((yield* find(['<root>/.hidden-folder/folder-in-hidden-folder'])).files).toEqual([
        '.hidden-folder/folder-in-hidden-folder/file.txt',
      ]);
      const withHidden = yield* find(['<root>/**/*'], true);
      expect(withHidden.files).toEqual(expect.arrayContaining(hidden));
    }),
  );

  it.effect('finds nothing in an empty folder, a missing path, or only exclusions', () =>
    Effect.gen(function* () {
      expect(yield* find(['<root>/folder-g'])).toMatchObject({ files: [] });
      expect(yield* find(['<root>/nope'])).toMatchObject({ files: [] });
      expect(yield* find(['!<root>/folder-d'])).toMatchObject({ files: [] });
      expect(yield* find(['# only a comment'])).toMatchObject({ files: [] });
    }),
  );

  it.effect('takes `[x]` as a literal character, and a folder name holding brackets', () =>
    Effect.gen(function* () {
      expect((yield* find(['<root>/folder-[f]'])).files).toEqual([
        'folder-f/extraSearch-item3.txt',
      ]);
      expect((yield* find(['<root>/with[[]brackets]/*'])).rootDirectory).toBe(
        '<root>/with[brackets]',
      );
    }),
  );

  it.effect('follows a symlink, drops a broken one, and stops at a cycle', () =>
    Effect.gen(function* () {
      const dir = join(root, 'links');
      yield* Effect.promise(async () => {
        await mkdir(join(dir, 'real'), { recursive: true });
        await writeFile(join(dir, 'real', 'file.txt'), 'x');
        await symlink(join(dir, 'real', 'file.txt'), join(dir, 'to-file.txt'));
        await symlink(join(dir, 'real'), join(dir, 'to-folder'));
        await symlink(join(dir, 'nowhere'), join(dir, 'broken'));
        await symlink(dir, join(dir, 'real', 'cycle'));
      });
      expect((yield* find(['<root>/links'])).files).toEqual([
        'links/real/file.txt',
        'links/to-file.txt',
        'links/to-folder/file.txt',
      ]);
    }),
  );

  it.effect.each([
    ['../outside', `Invalid pattern '../outside'. Relative pathing '.' and '..' is not allowed.`],
    ['a/./b', `Invalid pattern 'a/./b'. Relative pathing '.' and '..' is not allowed.`],
    ['!', 'pattern cannot be empty'],
  ])('refuses the pattern %s', ([line, message]) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(find([line ?? '']))).message).toBe(message);
    }),
  );
});
