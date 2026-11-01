// One JSON object per line on stdout: greppable, and easy to ship somewhere later.

export type LogFields = Readonly<Record<string, unknown>>;
export type LogFn = (msg: string, fields?: LogFields) => void;

export interface Logger {
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
}

export interface LoggerOptions {
  stream?: { write(chunk: string): unknown };
  now?: () => number;
}

export function createLogger({
  stream = process.stdout,
  now = Date.now,
}: LoggerOptions = {}): Logger {
  const write =
    (level: "info" | "warn" | "error"): LogFn =>
    (msg, fields) => {
      stream.write(`${JSON.stringify({ t: now(), level, msg, ...fields })}\n`);
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
