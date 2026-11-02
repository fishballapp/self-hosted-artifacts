import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const MAIN = new URL('./main.ts', import.meta.url).pathname;

describe('node src/main.ts', () => {
  it('fails at startup with a clear message when the config is bad', async () => {
    await expect(
      promisify(execFile)(process.execPath, [MAIN], { env: { PATH: process.env.PATH } }),
    ).rejects.toMatchObject({ code: 1, stderr: 'STORE_DIR is required\n' });
  });

  it('runs with no build step and answers /healthz', async () => {
    const storeDir = await mkdtemp(join(tmpdir(), 'self-hosted-artifacts-main-'));
    const child = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH,
        STORE_DIR: storeDir,
        OIDC_AUDIENCE: 'self-hosted-artifacts',
        OIDC_REPOSITORY_OWNER_ID: '42',
        LINK_BASES: '{"home":"http://192.0.2.1:8420"}',
        HOST: '127.0.0.1',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        child.once('exit', code => reject(new Error(`main exited with ${code}`)));
        child.stdout.setEncoding('utf8').on('data', (text: string) => {
          const match = /"port":(\d+)/.exec(text);
          if (match?.[1] !== undefined) resolve(match[1]);
        });
      });
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(200);
    } finally {
      child.removeAllListeners('exit');
      child.kill();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
