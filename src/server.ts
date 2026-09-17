import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { dataDir } from './directory.ts';
import { createStderrLogger, createServer } from './mcp.ts';

serveStdio(() =>
  createServer({
    dataDir: dataDir(process.env),
    clock: () => new Date(),
    log: createStderrLogger(),
  }),
);
