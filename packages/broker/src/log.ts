const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function createLogger(level: Level = "info") {
  const min = LEVELS[level];
  const emit = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
    info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
    error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
  };
}
export type Logger = ReturnType<typeof createLogger>;
