// Entry do bundle do servidor MCP: compõe os adaptadores reais (compose.ts) e serve o `createServer`
// 1.0 por stdio. Escolhe o relógio, o cwd e o destino do log do servidor; os scripts compõem por
// `openReadOnly` e `openWriter`.
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
// O SDK encerra o servidor sem resposta quando uma linha passa do teto do buffer (10 MiB): o
// `onerror` é o único rastro da causa. Só relata, não muda o que vai ao fio.
serveStdio(() => createServer({ services, isLegacy, logger }), {
  // O `message` de um ZodError (envelope JSON-RPC inválido) lista as chaves extras e cresce com o
  // payload: o getter monta a string inteira, então só não lê-lo mantém o stderr e o RSS baixos.
  onerror: (error) =>
    logger({
      level: 'error',
      event: 'transport-error',
      name: error.name,
      ...('issues' in error && Array.isArray(error.issues)
        ? { issues: error.issues.length }
        : { message: error.message }),
    }),
});
