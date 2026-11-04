import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { describe, expect, it } from 'vitest';
import { ServerConfig } from './config.ts';
import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, startFakeS3 } from './s3-fake.ts';
import { s3StoreLayer } from './s3-store.ts';
import { ArtifactRoutes, ResponseBreaker } from './server.ts';
import { DiskStore } from './store.ts';
import { verifierAnswering } from './test-support.ts';

const SERVER = new URL('./server.ts', import.meta.url).pathname;
const S3_STORE = new URL('./s3-store.ts', import.meta.url).pathname;
const WORKER = new URL('./worker.ts', import.meta.url).pathname;

/** Value imports only: a type's import is gone by the time this runs anywhere. */
const IMPORT = /^(?:import|export)\s(?!type\s)(?:[^;']*?\sfrom\s)?'([^']+)';/gmu;

/** Every file `entry` reaches through relative imports, with what each imports from outside them. */
const importGraphOf = async (entry: string) => {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    const source = await readFile(file, 'utf8');
    files.set(file, source);
    for (const [, specifier = ''] of source.matchAll(IMPORT)) {
      if (specifier.startsWith('.')) {
        await visit(join(dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  };
  await visit(entry);
  return { files, packages };
};

describe.each([
  ['server.ts', SERVER, ['config.ts', 'log.ts', 'oidc.ts', 'protocol.ts', 'store-contract.ts']],
  ['s3-store.ts', S3_STORE, ['config.ts', 'log.ts', 's3-bucket.ts', 's3-sigv4.ts', 'transport.ts']],
  ['worker.ts', WORKER, ['config.ts', 'oidc.ts', 's3-store.ts', 'server.ts']],
])('%s, which a Worker runs', (_, entry, reaches) => {
  it('reaches files, as this would otherwise pass by finding none', async () => {
    const { files, packages } = await importGraphOf(entry);
    expect([...files.keys()].map(file => file.split('/').pop())).toEqual(
      expect.arrayContaining(reaches),
    );
    expect(packages.size).toBeGreaterThan(0);
  });

  it('holds nothing of what only Node has', async () => {
    const { files, packages } = await importGraphOf(entry);
    expect([...files.keys()].map(file => file.split('/').pop())).not.toContain('store.ts');
    const nodeOnly = [...packages].filter(
      specifier =>
        specifier.startsWith('@effect/platform-node') ||
        (specifier.startsWith('node:') && specifier !== 'node:crypto'),
    );
    expect(nodeOnly).toEqual([]);
  });

  it('touches no `Temporal`, which workerd lacks', async () => {
    const { files } = await importGraphOf(entry);
    const using = [...files].filter(([, source]) => /\bTemporal\./u.test(source));
    expect(using.map(([file]) => file)).toEqual([]);
  });
});

describe("a Worker's web handler", () => {
  it('answers through the routes, with a bucket behind them', async () => {
    const fake = await startFakeS3({ isPublic: false });
    const config = {
      store: { kind: 's3', bucket: 'builds', region: 'auto', endpoint: fake.endpoint },
      oidcAudience: 'self-hosted-artifacts',
      oidcRepositoryOwnerId: '42',
      linkBases: { home: 'https://files.example' },
      host: '127.0.0.1',
      port: 0,
      defaultRetentionDays: 7,
      maxRetentionDays: 30,
      maxFileBytes: 1024,
    } as const;
    const { handler, dispose } = HttpRouter.toWebHandler(
      ArtifactRoutes.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, config),
            verifierAnswering(async () => ({
              kind: 'verified',
              repository: 'fishballapp/private-thing',
              scope: { repositoryId: '7', runId: '100', runAttempt: '1' },
            })),
            s3StoreLayer(config.store).pipe(
              Layer.provide(
                Layer.mergeAll(
                  FetchHttpClient.layer,
                  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({
                      AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY_ID,
                      AWS_SECRET_ACCESS_KEY: FAKE_SECRET_ACCESS_KEY,
                    }),
                  ),
                ),
              ),
            ),
            Layer.succeed(ResponseBreaker, { breakResponse: () => Effect.void }),
          ),
        ),
      ),
      { disableLogger: true },
    );
    try {
      const headers = { Authorization: 'Bearer anything' };
      const body = new TextEncoder().encode('x');
      const digest = createHash('sha256').update(body).digest('hex');
      const declaration = `name=a.apk&digest=${digest}&size=1`;

      const created = await handler(
        new Request(`https://files.example/uploads?${declaration}`, { method: 'POST', headers }),
      );
      expect(created.status).toBe(201);
      const { upload } = (await created.json()) as {
        upload: { id: string; url: string; headers: Record<string, string> };
      };
      expect((await fetch(upload.url, { method: 'PUT', headers: upload.headers, body })).ok).toBe(
        true,
      );
      const committed = await handler(
        new Request(`https://files.example/uploads/${upload.id}/commit?${declaration}`, {
          method: 'POST',
          headers,
        }),
      );
      expect(committed.status).toBe(201);

      const link = `https://files.example/${upload.id}/a.apk`;
      const read = await handler(new Request(link));
      expect(read.status).toBe(302);
      const fromBucket = await fetch(read.headers.get('location') ?? '');
      expect(await fromBucket.text()).toBe('x');

      const head = await handler(new Request(link, { method: 'HEAD' }));
      expect(head.status).toBe(200);
      expect(head.headers.get('location')).toBeNull();
    } finally {
      await dispose();
      await fake.stop();
    }
  });

  it('answers through the routes, with a disk behind them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-web-'));
    const config = {
      store: { kind: 'disk', dir, minFreeBytes: 0 },
      oidcAudience: 'self-hosted-artifacts',
      oidcRepositoryOwnerId: '42',
      linkBases: { home: 'https://files.example' },
      host: '127.0.0.1',
      port: 0,
      defaultRetentionDays: 7,
      maxRetentionDays: 30,
      maxFileBytes: 1024,
    } as const;
    const { handler, dispose } = HttpRouter.toWebHandler(
      ArtifactRoutes.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, config),
            verifierAnswering(async () => ({
              kind: 'verified',
              repository: 'fishballapp/private-thing',
              scope: { repositoryId: '7', runId: '100', runAttempt: '1' },
            })),
            DiskStore.layerWithStore(config.store).pipe(Layer.provide(NodeServices.layer)),
            Layer.succeed(ResponseBreaker, { breakResponse: () => Effect.void }),
          ),
        ),
      ),
      { disableLogger: true },
    );
    try {
      const headers = { Authorization: 'Bearer anything' };
      const health = await handler(new Request('https://files.example/healthz'));
      expect(health.status).toBe(200);

      const digest = 'a'.repeat(64);
      const created = await handler(
        new Request(`https://files.example/uploads?name=a.apk&digest=${digest}&size=1`, {
          method: 'POST',
          headers,
        }),
      );
      expect(created.status).toBe(201);
      const { upload } = (await created.json()) as { upload: { id: string } };

      const commit = await handler(
        new Request(
          `https://files.example/uploads/${upload.id}/commit?name=a.apk&digest=${digest}&size=1`,
          { method: 'POST', headers },
        ),
      );
      expect(commit.status).toBe(404);

      const listed = await handler(new Request('https://files.example/artifacts', { headers }));
      expect(await listed.json()).toEqual({ artifacts: [] });

      const unknown = await handler(
        new Request(`https://files.example/${randomBytes(32).toString('base64url')}/a.apk`),
      );
      expect(unknown.status).toBe(404);

      // No route takes a body here: that's what a store with its own target is for.
      const put = await handler(
        new Request(`https://files.example/uploads/${upload.id}`, { method: 'PUT', body: 'a' }),
      );
      expect(put.status).toBe(404);
    } finally {
      await dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
