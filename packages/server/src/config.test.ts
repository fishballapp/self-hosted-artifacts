import { describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from './config.ts';

const GOOD_ENV = {
  STORE_DIR: '/srv/artifacts',
  OIDC_AUDIENCE: 'self-hosted-artifacts',
  OIDC_REPOSITORY_OWNER_ID: '42',
  LINK_BASES: '{"home":"http://192.0.2.1:8420","public":"https://files.example/"}',
};

describe('readConfig', () => {
  it('fills in the defaults and trims a base URL', () => {
    expect(readConfig(GOOD_ENV)).toEqual({
      storeDir: '/srv/artifacts',
      oidcAudience: 'self-hosted-artifacts',
      oidcRepositoryOwnerId: '42',
      linkBases: { home: 'http://192.0.2.1:8420', public: 'https://files.example' },
      host: '0.0.0.0',
      port: 8420,
      defaultRetentionDays: 7,
      maxRetentionDays: 30,
      minFreeBytes: 20 * 1024 ** 3,
      maxFileBytes: 2 * 1024 ** 3,
    });
  });

  it('reads the optional settings', () => {
    const config = readConfig({
      ...GOOD_ENV,
      HOST: '127.0.0.1',
      PORT: '9000',
      DEFAULT_RETENTION_DAYS: '1',
      MAX_RETENTION_DAYS: '2',
      MIN_FREE_BYTES: '0',
      MAX_FILE_BYTES: '5',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9000,
      defaultRetentionDays: 1,
      maxRetentionDays: 2,
      minFreeBytes: 0,
      maxFileBytes: 5,
    });
  });

  it.each(['STORE_DIR', 'OIDC_AUDIENCE', 'OIDC_REPOSITORY_OWNER_ID', 'LINK_BASES'])(
    'fails when %s is missing',
    name => {
      const env = { ...GOOD_ENV, [name]: undefined };
      expect(() => readConfig(env)).toThrow(new ConfigError(`${name} is required`));
    },
  );

  it.each([
    ['STORE_DIR', 'relative/path'],
    ['OIDC_REPOSITORY_OWNER_ID', 'fishballapp'],
    ['LINK_BASES', 'not json'],
    ['LINK_BASES', '[]'],
    ['LINK_BASES', '{}'],
    ['LINK_BASES', '{"home":"ftp://files.example"}'],
    ['LINK_BASES', '{"home":3}'],
    ['HOST', ''],
    ['PORT', '70000'],
    ['PORT', 'http'],
    ['PORT', ''],
    ['DEFAULT_RETENTION_DAYS', '0'],
    ['MAX_RETENTION_DAYS', '-1'],
    ['MIN_FREE_BYTES', '1.5'],
    ['MAX_FILE_BYTES', '0'],
  ])('fails when %s is "%s", naming it', (name, value) => {
    expect(() => readConfig({ ...GOOD_ENV, [name]: value })).toThrow(name);
  });
});
