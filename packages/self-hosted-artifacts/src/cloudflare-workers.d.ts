/** The one thing used of what workerd adds, which `@cloudflare/workers-types` would add to every file's globals. */
declare module 'cloudflare:workers' {
  export const env: Readonly<Record<string, unknown>>;
}
