import { randomBytes } from 'node:crypto';

/** What every target holds a value to. The actions import this, so no `Temporal` here. */
/**
 * Upstream's rule, and what a name reaching a runner's path or a log needs on top of it: no control
 * character at all, never `.` or `..`, with or without the `.zip` a folder's name leaves off, and no
 * `##[`, which the runner reads as a command anywhere in a line of a step's log.
 */
const FILE_NAME = /^(?!\.{0,2}(?:\.[Zz][Ii][Pp])?$)(?!.*##\[)[^"*/:<>?\\|\p{Cc}\p{Cs}]+$/u;
const MAX_FILE_NAME_BYTES = 255;
export const isFileName = (name: string) =>
  FILE_NAME.test(name) && new TextEncoder().encode(name).length <= MAX_FILE_NAME_BYTES;
export const FILE_NAME_MESSAGE =
  'name must be 1 to 255 bytes, not . or .., without ", :, <, >, |, *, ?, \\, /, ##[ or a control character';
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

/** RFC 3986: `encodeURIComponent` plus the four characters it leaves alone. */
export const uriEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!*'()]/gu,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** A header only holds a name as it is in ASCII, and `%` reads as an escape to some browsers. */
export const attachmentOf = (name: string) => {
  const plain = name.replaceAll(/[^\x20-\x24\x26-\x7e]/gu, '_');
  const attachment = `attachment; filename="${plain}"`;
  return plain === name ? attachment : `${attachment}; filename*=UTF-8''${uriEncode(name)}`;
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
