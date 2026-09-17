import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { dirDados } from './directory.ts';
import { createStderrLogger, createServer } from './mcp.ts';

serveStdio(() =>
  createServer({
    dataDir: dirDados(process.env),
    clock: () => new Date(),
    log: createStderrLogger(),
  }),
);
