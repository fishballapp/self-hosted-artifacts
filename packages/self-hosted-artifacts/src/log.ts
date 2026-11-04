import * as Predicate from 'effect/Predicate';

export type Log = (line: string) => void;

export const shortToken = (token: string): string => `${token.slice(0, 8)}…`;

export const codeOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, 'code') && Predicate.isString(error.code) ? error.code : undefined;

/** A system error's message holds its file path, and a path in the store holds a download token. */
export const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown error';
  // A PlatformError carries Node's error as its cause.
  return codeOf(error) ?? codeOf(error.cause) ?? `${error.name}: ${error.message}`;
};
