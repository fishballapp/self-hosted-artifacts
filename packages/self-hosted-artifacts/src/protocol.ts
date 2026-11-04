import { randomBytes } from 'node:crypto';

/** What every target holds a value to. The actions import this, so no `Temporal` here. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
export const FILE_NAME_MESSAGE = 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,254}';
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{43}$/u;
export const SHA_256 = /^[0-9a-f]{64}$/u;
/** Reaches a path only as a hash. */
export const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;
/** Reaches a path, so bounded too: a longer one would be an error from the disk, not a `400`. */
export const RUN_ID = /^[0-9]{1,32}$/u;

export const S3_BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
export const S3_REGION = /^[A-Za-z0-9-]{1,64}$/u;
const HTTP_BASE = /^https?:\/\/[^\s?#]+$/u;

/** A URL its later uses can't throw on: `URL` takes a bad escape in a path, and decoding it doesn't. */
export const isHttpBase = (text: string) => {
  const url = HTTP_BASE.test(text) ? URL.parse(text) : null;
  if (url === null) return false;
  try {
    decodeURIComponent(url.pathname);
    return true;
  } catch {
    return false;
  }
};

export const NAME_TAKEN =
  'An artifact with this name already exists on the workflow run. Set overwrite to replace it';
export const OTHER_REPOSITORY = 'A job can only delete artifacts of its own repository';
export const BAD_RETENTION = 'retention-days must be a positive integer';

/**
 * 256 random bits, as URL-safe text. Never starting with `-`, which a command line would read as a
 * flag: `--artifact-id -abc` would print the usage and exit 0.
 */
export const newArtifactId = () => randomBytes(32).toString('base64url').replace(/^-/u, 'A');
