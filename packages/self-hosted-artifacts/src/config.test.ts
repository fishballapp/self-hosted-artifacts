import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { parseConfig, readConfigFile } from './config.ts';

const GOOD_SETTINGS = {
  storeDir: '/srv/artifacts',
  oidcAudience: 'self-hosted-artifacts',
  oidcRepositoryOwnerId: 42,
  linkBases: { home: 'http://192.0.2.1:8420', public: 'https://files.example/' },
};

const parse = (settings: unknown) => parseConfig(JSON.stringify(settings));

describe('parseConfig', () => {
  it.effect('fills in the defaults and trims a base URL', () =>
    Effect.gen(function* () {
      expect(yield* parse(GOOD_SETTINGS)).toEqual({
        storeDir: '/srv/artifacts',
        oidcAudience: 'self-hosted-artifacts',
        oidcRepositoryOwnerId: '42',
        linkBases: { home: 'http://192.0.2.1:8420', public: 'https://files.example' },
        host: '0.0.0.0',
        port: 8420,
        defaultRetentionDays: 90,
        maxRetentionDays: 90,
        minFreeBytes: 20 * 1024 ** 3,
        maxFileBytes: 2 * 1024 ** 3,
      });
    }),
  );

  it.effect('reads the optional settings', () =>
    Effect.gen(function* () {
      const config = yield* parse({
        ...GOOD_SETTINGS,
        host: '127.0.0.1',
        port: 9000,
        defaultRetentionDays: 1,
        maxRetentionDays: 2,
        minFreeGiB: 0,
        maxFileGiB: 0.5,
      });
      expect(config).toMatchObject({
        host: '127.0.0.1',
        port: 9000,
        defaultRetentionDays: 1,
        maxRetentionDays: 2,
        minFreeBytes: 0,
        maxFileBytes: 512 * 1024 ** 2,
      });
    }),
  );

  it.effect.each(['storeDir', 'oidcAudience', 'oidcRepositoryOwnerId', 'linkBases'])(
    'fails when %s is missing, naming it',
    name =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parse({ ...GOOD_SETTINGS, [name]: undefined }));
        expect(error.message).toContain(`["${name}"]`);
      }),
  );

  it.effect.each<[string, unknown]>([
    ['storeDir', 'relative/path'],
    ['storeDir', 3],
    ['oidcAudience', ''],
    ['oidcRepositoryOwnerId', 'fishballapp'],
    ['oidcRepositoryOwnerId', '42'],
    ['oidcRepositoryOwnerId', 0],
    ['oidcRepositoryOwnerId', 1e21],
    ['linkBases', 'http://192.0.2.1:8420'],
    ['linkBases', []],
    ['linkBases', {}],
    ['linkBases', { home: 'ftp://files.example' }],
    ['linkBases', { home: 3 }],
    ['linkBases', { home: 'http://[' }],
    ['linkBases', { home: 'http://files.example:abc' }],
    ['linkBases', { home: 'http://files.example\n' }],
    ['linkBases', { home: 'http://files.example ' }],
    ['linkBases', { home: 'http://files.example?x=1' }],
    ['linkBases', { home: 'http://files.example#x' }],
    ['host', ''],
    ['port', 70000],
    ['port', '8420'],
    ['port', 1.5],
    ['defaultRetentionDays', 0],
    ['maxRetentionDays', -1],
    ['minFreeGiB', -1],
    ['minFreeGiB', '20'],
    ['maxFileGiB', 0],
    ['maxFileGiB', 1e-12],
    ['maxFileGiB', 1e300],
    ['minFreeGiB', 1e300],
  ])('fails when %s is %j, naming it', ([name, value]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parse({ ...GOOD_SETTINGS, [name]: value }));
      expect(error.message).toContain(`["${name}"]`);
    }),
  );

  it.effect('fails on an unknown setting, so a typo is not a silent default', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parse({ ...GOOD_SETTINGS, maxRetentionDay: 3 }));
      expect(error.message).toContain('["maxRetentionDay"]');
    }),
  );

  it.effect.each([[[]], ['text'], [null]])('fails when the config is %j', settings =>
    Effect.flip(parse(settings)),
  );
});

describe('readConfigFile', () => {
  const withFile = <A, E, R>(text: string, test: (path: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), 'self-hosted-artifacts-config-'))),
      dir =>
        Effect.gen(function* () {
          const path = join(dir, 'config.json');
          yield* Effect.promise(() => writeFile(path, text));
          return yield* test(path);
        }),
      dir => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );

  it.effect('reads a config from a file', () =>
    withFile(JSON.stringify(GOOD_SETTINGS), path =>
      Effect.gen(function* () {
        expect(yield* readConfigFile(path)).toMatchObject({ storeDir: '/srv/artifacts' });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails when the file is not JSON, naming the file', () =>
    withFile('{ nope', path =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(readConfigFile(path));
        expect(error.message).toContain(`The config file ${path} is invalid`);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails when the file cannot be read, naming the file and the reason', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readConfigFile('/nonexistent/config.json'));
      expect(error.message).toBe("Can't read the config file /nonexistent/config.json: ENOENT");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
