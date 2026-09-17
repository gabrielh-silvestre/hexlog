import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNil } from 'es-toolkit';
import { ErroHexlog } from './erros.ts';

/** §4.2: nomes de processo reservados para as definições do projeto. */
export const PROCESSOS_RESERVADOS = ['schemas', 'vocabulario', 'gates'] as const;

/** §4.2: nomes de tipo reservados para os eventos nativos. */
export const TIPOS_RESERVADOS = ['marco', 'veredito'] as const;

/** §4.11: nomes de gate embutidos, reservados para `registrar_gate`. */
export const GATES_EMBUTIDOS_NOMES = [
  'sem-orfaos',
  'sem-conflitos',
  'cadeia-integra',
  'sem-referencias-invalidas',
] as const;

/**
 * Resolve `dir/...partes` e afirma, em defesa de profundidade, que o resultado não escapou
 * de `dir` (§4.2). Nomes já são validados por `Nome` antes de chegar aqui; este é o último gate.
 */
export function caminho(dir: string, ...partes: string[]): string {
  const resolvido = path.resolve(dir, ...partes);
  if (resolvido !== dir && !resolvido.startsWith(dir + path.sep)) {
    throw new ErroHexlog('INTERNO', 'caminho resolvido escapa do diretório de dados');
  }
  return resolvido;
}

/** Grava `valor` como JSON em `arquivo` atomicamente: tmp no mesmo diretório + fsync + rename. */
export function escreverJsonAtomico(arquivo: string, valor: unknown): void {
  const dir = path.dirname(arquivo);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(
    dir,
    `.${path.basename(arquivo)}.${process.pid}.${randomBytes(4).toString('hex')}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(valor, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, arquivo);
}

/** Lê `arquivo` como JSON. Inexistente → `null`. Ilegível (fs ou parse) → `ErroHexlog('ERRO_IO')`. */
export function lerJson(arquivo: string): unknown {
  let texto: string;
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw erroIo(e);
  }

  try {
    return JSON.parse(texto);
  } catch (e) {
    throw erroIo(e);
  }
}

/** Mapeia uma exceção de I/O (errno de fs, ou de parse) para `ErroHexlog('ERRO_IO')` (§4.13). */
export function erroIo(e: unknown): ErroHexlog {
  const erro = e as NodeJS.ErrnoException;
  const codigo = isNil(erro.code) ? 'desconhecido' : erro.code;
  return new ErroHexlog('ERRO_IO', 'falha de I/O', [
    { caminho: '', codigo, mensagem: erro.message },
  ]);
}
