// Substitui `claude mcp add`/`remove` no B3 (`HEXLOG_REGISTRAR_MCP`): grava
// `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (confirmada em
// `.mcpServers.gitnexus`: command+args+env), sem exigir o binário `claude`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const [, , execPath, arquivoServidor] = process.argv;
if (execPath === undefined || arquivoServidor === undefined) {
  throw new Error('uso: instalar-mcp-falso.ts <execPath> <arquivoServidor>');
}

// Forma mínima de `~/.claude.json` que este fixture lê e regrava, com passthrough pro resto.
const ClaudeJsonSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

const caminho = path.join(os.homedir(), '.claude.json');
const dados: z.infer<typeof ClaudeJsonSchema> = fs.existsSync(caminho)
  ? ClaudeJsonSchema.parse(JSON.parse(fs.readFileSync(caminho, 'utf8')))
  : {};
dados.mcpServers = {
  ...dados.mcpServers,
  hexlog: { command: execPath, args: [arquivoServidor], env: {} },
};
fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
