// Structured log: one JSON object per line on stdout. A request line holds
// time, user, space, tool and outcome; never contents, never tokens.

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Log {
  private level: Level;
  private readonly out: (line: string) => void;

  constructor(level: Level = "info", out: (line: string) => void = (line) => process.stdout.write(line + "\n")) {
    this.level = level;
    this.out = out;
  }

  setLevel(level: Level) {
    this.level = level;
  }

  write(level: Level, event: string, fields: Record<string, unknown> = {}) {
    if (ORDER[level] < ORDER[this.level]) return;
    this.out(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  }

  debug = (event: string, fields?: Record<string, unknown>) => this.write("debug", event, fields);
  info = (event: string, fields?: Record<string, unknown>) => this.write("info", event, fields);
  warn = (event: string, fields?: Record<string, unknown>) => this.write("warn", event, fields);
  error = (event: string, fields?: Record<string, unknown>) => this.write("error", event, fields);

  /** The request log of the security model: who did what, where, with which outcome. */
  request(fields: { user: string; space: string | null; tool: string; outcome: string; ms: number; detail?: string }) {
    this.write("info", "request", fields);
  }
}

export const log = new Log();
