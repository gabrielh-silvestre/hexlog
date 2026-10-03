// Entry descartável da prévia (F5): faz o que o `src/server.ts` 1.0 fará (compose + createServer +
// stdio), sem tocar o `src/server.ts` atual. Só importa a árvore nova e a raiz permitida (P6).
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { compose } from '../../src/compose.ts';
import { dataDir } from '../../src/directory.ts';
import { createServer } from '../../src/mcp/server.ts';
import type { LogRecord } from '../../src/shared/logger.ts';

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
