// Entrypoint de probe para o bundle do futuro hook (`hook/bash-guard.ts`,
// sub-passo 6b): importa `shell-quote`, `es-toolkit` e `src/directory.ts` e
// sai com um código diferente conforme o comando recebido é reconhecido.
import { parse } from 'shell-quote';
import { isNotNil } from 'es-toolkit';
import { dirDados } from '../../src/directory.ts';

const comando = process.argv[2] ?? '';
const tokens = parse(comando);
const dados = dirDados(process.env);

const comandoReconhecido = isNotNil(tokens[0]) && typeof tokens[0] === 'string';

process.stderr.write(JSON.stringify({ tokens, dados }));
process.exit(comandoReconhecido ? 0 : 1);
