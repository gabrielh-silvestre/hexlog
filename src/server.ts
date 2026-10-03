// Entry do bundle do servidor MCP: compõe os adaptadores reais (compose.ts) e serve o `createServer`
// 1.0 por stdio. É a única ponta que escolhe o relógio, o cwd e o destino do log.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { compose } from './compose.ts';
import { dataDir } from './directory.ts';
import { createServer } from './mcp/server.ts';
import type { LogRecord } from './shared/logger.ts';
import { VERSION } from './version.ts';

const logger = (record: LogRecord): void => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
};

const dir = dataDir(process.env);
const { services, isLegacy } = compose({
  dataDir: dir,
  cwd: process.cwd(),
  clock: () => new Date(),
  logger,
});

logger({ level: 'info', event: 'start', dataDir: dir, version: VERSION });
serveStdio(() => createServer({ services, isLegacy, logger }));
