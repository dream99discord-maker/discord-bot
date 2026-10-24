import type { AppConfig } from './config.js';

export function createLogger(config: AppConfig) {
  return {
    info(message: string, fields: Record<string, unknown> = {}) { console.info(JSON.stringify({ livello: 'info', message, ...fields })); },
    warn(message: string, fields: Record<string, unknown> = {}) { console.warn(JSON.stringify({ livello: 'warn', message, ...fields })); },
    error(message: string, fields: Record<string, unknown> = {}) { console.error(JSON.stringify({ livello: 'error', message, ...fields })); },
    debug(message: string, fields: Record<string, unknown> = {}) {
      if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') console.debug(JSON.stringify({ livello: 'debug', message, ...fields }));
    },
  };
}
