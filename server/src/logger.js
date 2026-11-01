// One JSON object per line on stdout: greppable, and easy to ship somewhere later.

export function createLogger({ stream = process.stdout, now = Date.now } = {}) {
  const write = (level) => (msg, fields) => {
    stream.write(`${JSON.stringify({ t: now(), level, msg, ...fields })}\n`);
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
