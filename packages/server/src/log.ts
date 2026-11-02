export type Log = (line: string) => void;

export const shortToken = (token: string): string => `${token.slice(0, 8)}…`;

/** A system error's message holds its file path, and a path in the store holds a download token. */
export const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown error';
  if ('code' in error && typeof error.code === 'string') return error.code;
  return `${error.name}: ${error.message}`;
};
