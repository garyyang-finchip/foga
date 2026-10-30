const prefix = "foga";

export const log = {
  info: (msg: string) => console.log(`${prefix}: ${msg}`),
  warn: (msg: string) => console.warn(`${prefix}: warning: ${msg}`),
  error: (msg: string) => console.error(`${prefix}: error: ${msg}`),
  step: (msg: string) => console.log(`  - ${msg}`),
};

export function fail(msg: string): never {
  log.error(msg);
  process.exit(1);
}
