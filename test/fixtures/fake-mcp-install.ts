// Substitui `claude mcp add`/`remove` no B3 (`HEXLOG_REGISTER_MCP`): grava
// `mcpServers.hexlog` em `~/.claude.json` na mesma forma real (confirmada em
// `.mcpServers.gitnexus`: command+args+env), sem exigir o binário `claude`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const [, , execPath, serverFile] = process.argv;
if (execPath === undefined || serverFile === undefined) {
  throw new Error('usage: fake-mcp-install.ts <execPath> <serverFile>');
}

// Forma mínima de `~/.claude.json` que este fixture lê e regrava, com passthrough pro resto.
const ClaudeJsonSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

const file = path.join(os.homedir(), '.claude.json');
const data: z.infer<typeof ClaudeJsonSchema> = fs.existsSync(file)
  ? ClaudeJsonSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  : {};
data.mcpServers = {
  ...data.mcpServers,
  hexlog: { command: execPath, args: [serverFile], env: {} },
};
fs.writeFileSync(file, JSON.stringify(data, null, 2));
