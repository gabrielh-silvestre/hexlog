// Entry do bundle do servidor MCP: compõe os adaptadores reais (compose.ts) e serve o `createServer`
// 1.0 por stdio. É a única ponta que escolhe o relógio, o cwd e o destino do log.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { compose } from './compose.ts';
import { dataDir } from './directory.ts';
import { createServer } from './mcp/server.ts';
import type { LogRecord } from './shared/logger.ts';

const logger = (record: LogRecord): void => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
};

const { services, isLegacy } = compose({
  dataDir: dataDir(process.env),
  cwd: process.cwd(),
  clock: () => new Date(),
  logger,
});

serveStdio(() => createServer({ services, isLegacy, logger }));
