export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/** Structured JSON-lines logger. Lines below `minLevel` are dropped. */
export function createLogger(minLevel: LogLevel = 'info', sink: LogSink = stderrSink): Logger {
  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    sink(JSON.stringify({ level, message, ...fields }));
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

/** Logger that discards everything; used by tests. */
export const silentLogger: Logger = createLogger('error', () => undefined);
