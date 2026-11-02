import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.ts';
import { describeError, type Log, shortToken } from './log.ts';
import type { TokenVerifier } from './oidc.ts';
import { type Store, UPLOAD_TIMEOUT_MS } from './store.ts';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const UPLOAD_URL = /^\/artifacts(?:\?(.*))?$/;
const DOWNLOAD_URL = /^\/([A-Za-z0-9_-]{43})\/([^/?#]+)$/;
const REFUSED_BODY_GRACE_MS = 5_000;
// A client that stops reading or sending gets cut off, so a stalled download can't keep an expired
// file's blocks on disk after its sweep. Long enough for a phone to return from the background. With
// a write pending, Node restarts this timer, so a stalled download goes at two or three times this.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const respondJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

const respondNotFound = (res: ServerResponse) => respondJson(res, 404, { error: 'Not found' });

/**
 * Answers an upload whose body is still unread. Node discards what arrives next, so the connection
 * stays open long enough for the client to read the answer: closing on unread bytes can reset the
 * connection and lose it. A client still sending after the grace period gets cut off.
 */
const refuse = (req: IncomingMessage, res: ServerResponse, status: number, message: string) => {
  respondJson(res, status, { error: message });
  const cutOff = setTimeout(() => req.destroy(), REFUSED_BODY_GRACE_MS).unref();
  req.once('close', () => clearTimeout(cutOff));
};

const parseRetentionDays = (
  value: string | null,
  { defaultRetentionDays, maxRetentionDays }: Config,
): number | undefined => {
  if (value === null) return Math.min(defaultRetentionDays, maxRetentionDays);
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Math.min(Number(value), maxRetentionDays);
};

export const createArtifactServer = ({
  config,
  store,
  verifyToken,
  log,
}: {
  config: Config;
  store: Store;
  verifyToken: TokenVerifier;
  log: Log;
}): Server => {
  const upload = async (req: IncomingMessage, res: ServerResponse, query: string) => {
    const refuseAndLog = (status: number, message: string, reason = message) => {
      log(`upload refused status=${status} reason="${reason}"`);
      refuse(req, res, status, message);
    };

    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined) return refuseAndLog(401, 'Token rejected', 'no bearer token');
    const verification = await verifyToken(token);
    if (verification.kind === 'unavailable') {
      return refuseAndLog(503, 'GitHub signing keys are unavailable', verification.reason);
    }
    if (verification.kind === 'rejected') {
      return refuseAndLog(401, 'Token rejected', verification.reason);
    }

    const params = new URLSearchParams(query);
    const name = params.get('name');
    if (name === null || !FILE_NAME.test(name)) {
      return refuseAndLog(400, 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,254}');
    }
    const retentionDays = parseRetentionDays(params.get('retention-days'), config);
    if (retentionDays === undefined) {
      return refuseAndLog(400, 'retention-days must be a positive integer');
    }
    const contentLength = req.headers['content-length'];
    if (contentLength === undefined) return refuseAndLog(411, 'Content-Length is required');
    const size = Number(contentLength);
    if (size > config.maxFileBytes) {
      return refuseAndLog(413, `File is over the limit of ${config.maxFileBytes} bytes`);
    }
    if (!(await store.isPresent())) return refuseAndLog(503, 'The store is missing');
    if ((await store.freeBytes()) - size < config.minFreeBytes) {
      return refuseAndLog(507, 'Not enough free space on the server');
    }

    const logged = `repository=${verification.repository} name=${name} size=${size}`;
    const stored = await (async () => {
      try {
        return await store.put({ name, size, retentionDays, body: req });
      } catch (error) {
        log(`upload stopped ${logged} reason="${describeError(error)}"`);
        return undefined;
      }
    })();
    if (stored === undefined) return refuse(req, res, 500, 'Upload failed');

    log(`upload ${logged} token=${shortToken(stored.token)} expiresAt=${stored.expiresAt}`);
    respondJson(res, 201, {
      name,
      size,
      expiresAt: stored.expiresAt.toString(),
      links: Object.fromEntries(
        Object.entries(config.linkBases).map(([label, base]) => [
          label,
          `${base}/${stored.token}/${name}`,
        ]),
      ),
    });
  };

  const download = async (
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    name: string,
  ) => {
    const artifact = await store.find(token, name);
    if (artifact === undefined) return respondNotFound(res);

    log(`${req.method} token=${shortToken(token)} name=${name} size=${artifact.size}`);
    res.writeHead(200, {
      'Content-Length': artifact.size,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    if (req.method === 'HEAD') return void res.end();
    await pipeline(createReadStream(artifact.dataPath), res).catch((error: unknown) => {
      log(`download stopped token=${shortToken(token)} reason="${describeError(error)}"`);
    });
    return undefined;
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url === '/healthz' && req.method === 'GET') {
      return (await store.isPresent())
        ? respondJson(res, 200, { status: 'ok' })
        : respondJson(res, 503, { error: 'The store is missing' });
    }
    const uploadMatch = UPLOAD_URL.exec(url);
    if (uploadMatch !== null && req.method === 'POST') {
      return await upload(req, res, uploadMatch[1] ?? '');
    }
    const [, token, name] = DOWNLOAD_URL.exec(url) ?? [];
    if (
      token !== undefined &&
      name !== undefined &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      return await download(req, res, token, name);
    }
    return respondNotFound(res);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      log(`request failed reason="${describeError(error)}"`);
      if (res.headersSent) return void res.destroy();
      return respondJson(res, 500, { error: 'Internal error' });
    });
  });
  server.requestTimeout = UPLOAD_TIMEOUT_MS;
  server.timeout = IDLE_TIMEOUT_MS;
  return server;
};
