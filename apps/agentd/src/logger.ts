/** Structured JSON log lines on stderr, one object per line, for journald. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(stream: NodeJS.WritableStream = process.stderr): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    stream.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n",
    );
  };
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
