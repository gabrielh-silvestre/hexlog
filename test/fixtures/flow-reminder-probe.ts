// Entrypoint de probe para o bundle do futuro hook (`hook/flow-reminder.ts`,
// passo 3): importa `yaml`, `zod` e `src/flow-map.ts` (via `parseFlowMap`) e
// sai com um código diferente conforme o frontmatter recebido é válido.
import { parseFlowMap } from '../../src/flow-map.ts';

const text = process.argv[2] ?? '';
const result = parseFlowMap(text);

process.stderr.write(JSON.stringify(result));
process.exit(result.success ? 0 : 1);
