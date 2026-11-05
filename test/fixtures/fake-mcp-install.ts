// Substitui `claude mcp add`/`remove` no instalador (`HEXLOG_REGISTER_MCP`): grava
// `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (confirmada em
// `.mcpServers.gitnexus`: command+args+env), sem exigir o binário `claude`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const [, , execPath, serverFile, envJson] = process.argv;
if (execPath === undefined || serverFile === undefined || envJson === undefined) {
  throw new Error('usage: fake-mcp-install.ts <execPath> <serverFile> <envJson>');
}

// `HEXLOG_FAKE_MCP_FAIL=1` simula o `claude mcp add` que falha: sai 1 sem gravar nada.
if (process.env.HEXLOG_FAKE_MCP_FAIL === '1') throw new Error('simulated claude mcp add failure');

// Forma mínima de `~/.claude.json` que este fixture lê e regrava, com passthrough pro resto.
const ClaudeJsonSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
const EnvSchema = z.record(z.string(), z.string());

const file = path.join(os.homedir(), '.claude.json');
const data: z.infer<typeof ClaudeJsonSchema> = fs.existsSync(file)
  ? ClaudeJsonSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  : {};
data.mcpServers = {
  ...data.mcpServers,
  hexlog: { command: execPath, args: [serverFile], env: EnvSchema.parse(JSON.parse(envJson)) },
};
fs.writeFileSync(file, JSON.stringify(data, null, 2));
