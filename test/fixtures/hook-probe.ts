// Entrypoint de probe para o bundle do futuro hook (`hook/bash-guard.ts`,
// sub-passo 6b): importa `shell-quote`, `es-toolkit` e `src/directory.ts` e
// sai com um código diferente conforme o comando recebido é reconhecido.
import { parse } from 'shell-quote';
import { isNotNil } from 'es-toolkit';
import { dataDir } from '../../src/directory.ts';

const command = process.argv[2] ?? '';
const tokens = parse(command);
const data = dataDir(process.env);

const recognizedCommand = isNotNil(tokens[0]) && typeof tokens[0] === 'string';

process.stderr.write(JSON.stringify({ tokens, data }));
// process.exitCode em vez de process.exit(): mesmo código de saída, sem sair
// antes do stderr ser flushado (regra n/no-process-exit).
process.exitCode = recognizedCommand ? 0 : 1;
