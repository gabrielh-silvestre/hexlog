import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from '../version.ts';
import type { ToolDeps } from './kernel.ts';
import { registerAttachmentTools } from './tools/attachment.ts';
import { registerDefinitionTools } from './tools/definition.ts';
import { registerProcessTools } from './tools/process.ts';
import { registerQueryTools } from './tools/query.ts';

/**
 * Monta o servidor MCP `hexlog` (12 tools): nome fixo, versão de `version.ts` e as quatro famílias
 * de tools sobre o mesmo contexto. Quem compõe (`compose.ts`, via `server.ts` ou a prévia) entrega
 * os serviços, o detector de dado 0.x e o logger; aqui nada toca disco.
 */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'hexlog', version: VERSION });
  registerProcessTools(server, deps);
  registerDefinitionTools(server, deps);
  registerAttachmentTools(server, deps);
  registerQueryTools(server, deps);
  return server;
}
