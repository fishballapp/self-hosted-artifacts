/** What both ends of the HTTP API hold a value to. The action imports this, so no `Temporal` here. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{43}$/u;
export const SHA_256 = /^[0-9a-f]{64}$/u;
/** Reaches a path only as a hash. */
export const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;
/** Reaches a path, so bounded too: a longer one would be an error from the disk, not a `400`. */
export const RUN_ID = /^[0-9]{1,32}$/u;
