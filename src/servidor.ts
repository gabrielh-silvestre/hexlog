import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { dirDados } from './diretorio.ts';
import { criarLoggerStderr, criarServidor } from './mcp.ts';

serveStdio(() =>
  criarServidor({
    dirDados: dirDados(process.env),
    relogio: () => new Date(),
    log: criarLoggerStderr(),
  }),
);
