import { openAsBlob } from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ATTEMPTS = 4;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

class PermanentFailure extends Error {}

const input = name => process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? '';

const requiredInput = name => {
  const value = input(name);
  if (value === '') throw new PermanentFailure(`The ${name} input is required`);
  return value;
};

const readFailure = async response => {
  const body = await response.json().catch(() => undefined);
  const message = body?.error ?? `HTTP ${response.status}`;
  return response.status >= 500 ? new Error(message) : new PermanentFailure(message);
};

// A line break in an output's value would add an output of the server's choosing.
const isOutputValue = value => typeof value === 'string' && !/[\r\n]/.test(value);

const openFile = async path => {
  const stats = await stat(path).catch(() => undefined);
  if (stats === undefined) throw new PermanentFailure(`No file at ${path}`);
  if (stats.isDirectory()) {
    throw new PermanentFailure(
      `${path} is a folder; folders are not supported yet. Upload one file`,
    );
  }
  return await openAsBlob(path);
};

const readTokenRequest = () => {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new PermanentFailure('No OIDC token available: add `permissions: id-token: write`');
  }
  return { url: new URL(url), token };
};

const mintToken = async ({ url, token }) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await readFailure(response);
  const { value } = await response.json();
  return value;
};

const main = async () => {
  const serverUrl = requiredInput('server-url').replace(/\/+$/, '');
  const path = requiredInput('path');
  const name = input('name') || basename(path);
  const retentionDays = input('retention-days');

  const file = await openFile(path);
  const tokenRequest = readTokenRequest();
  // The runner's URL already has a query string, so the audience has to join it.
  tokenRequest.url.searchParams.set('audience', input('audience') || 'self-hosted-artifacts');
  const uploadUrl = new URL(`${serverUrl}/artifacts`);
  uploadUrl.searchParams.set('name', name);
  if (retentionDays !== '') uploadUrl.searchParams.set('retention-days', retentionDays);

  const uploadOnce = async () => {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(tokenRequest)}`,
        'Content-Type': 'application/octet-stream',
      },
      body: file,
      // Without both, fetch clones the request to replay it on a redirect, and the clone holds the
      // whole file in memory.
      redirect: 'error',
      window: null,
    });
    if (!response.ok) throw await readFailure(response);
    return await response.json();
  };

  const uploadWithRetries = async attempt => {
    try {
      return await uploadOnce();
    } catch (error) {
      if (error instanceof PermanentFailure || attempt === ATTEMPTS) throw error;
      const delaySeconds = 2 ** (attempt - 1);
      process.stdout.write(
        `Attempt ${attempt} failed (${escapeCommand(describe(error))}), retrying in ${delaySeconds}s\n`,
      );
      await sleep(delaySeconds * 1000);
      return await uploadWithRetries(attempt + 1);
    }
  };

  const { expiresAt, links } = await uploadWithRetries(1);
  const [artifactUrl, ...otherLinks] = Object.values(links ?? {});
  if (![artifactUrl, expiresAt, ...otherLinks].every(isOutputValue)) {
    throw new PermanentFailure(`${serverUrl} answered without a usable link`);
  }
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `artifact-url=${artifactUrl}`,
      `links=${JSON.stringify(links)}`,
      `expires-at=${expiresAt}\n`,
    ].join('\n'),
  );
  process.stdout.write(`Uploaded ${name} (${file.size} bytes), expires at ${expiresAt}\n`);
};

const describe = error => {
  const cause = error?.cause?.message;
  return cause === undefined ? String(error?.message ?? error) : `${error.message}: ${cause}`;
};

// A workflow command ends at its line break, so one in the message has to be encoded.
const escapeCommand = message =>
  message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

try {
  await main();
} catch (error) {
  process.stdout.write(`::error::${escapeCommand(describe(error))}\n`);
  process.exitCode = 1;
}
