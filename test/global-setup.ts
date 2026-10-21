import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Isola o `TMPDIR` da execução num `hexlog-suite-*`: os workers herdam a variável, então
 * `os.tmpdir()` aponta para lá e o `global-teardown.ts` enxerga qualquer diretório que sobrar.
 *
 * Também apaga as variáveis locais do Git (`GIT_DIR`, `GIT_INDEX_FILE` etc.): um hook disparado a
 * partir de uma worktree vinculada as exporta, e os specs que rodam `git` num repositório temporário
 * passariam a operar no repositório real. Aqui, e não no `.husky/`, porque o lint-staged precisa do
 * `GIT_INDEX_FILE` do commit parcial; os workers herdam o ambiente já limpo.
 */
export default function setup(): void {
  process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-suite-'));
  const names = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  for (const name of (names.stdout ?? '').split('\n')) delete process.env[name];
}
