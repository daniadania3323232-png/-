export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  child(prefix: string): Logger;
}

export function createLogger(verbose: boolean, prefix = 'bridge'): Logger {
  const stamp = () => new Date().toISOString().slice(11, 19);
  const write = (level: string, msg: string) => {
    process.stderr.write(`${stamp()} [${prefix}] ${level} ${msg}\n`);
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    debug: (m) => {
      if (verbose) write('DEBUG', m);
    },
    child: (p) => createLogger(verbose, `${prefix}:${p}`),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};
