import * as os from 'node:os';
import * as path from 'node:path';
import { isUndefined } from 'es-toolkit';

/**
 * Diretório de dados do hexlog: `$XDG_DATA_HOME/hexlog` quando a variável
 * está definida, não vazia e é um caminho absoluto (XDG Base Directory 0.8);
 * senão `~/.local/share/hexlog`.
 */
export function dataDir(env: NodeJS.ProcessEnv): string {
  const xdgDataHome = env.XDG_DATA_HOME;
  if (!isUndefined(xdgDataHome) && path.isAbsolute(xdgDataHome)) {
    return path.join(xdgDataHome, 'hexlog');
  }
  return path.join(os.homedir(), '.local', 'share', 'hexlog');
}
