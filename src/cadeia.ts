import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isNil } from 'es-toolkit';
import { omit } from 'es-toolkit/compat';
import type { Detalhe } from './erros.ts';
import { Linha } from './eventos.ts';

export type MotivoQuebra = 'linha-invalida' | 'seq-divergente' | 'hash-nao-bate' | 'dados-invalidos';

export type Quebra = { indice: number; motivo: MotivoQuebra };

export type Cadeia = {
  ok: boolean;
  totalLinhas: number;
  cabeca: string;
  quebras: Quebra[];
  totalQuebras: number;
  linhasReparadas: number[];
};

const TETO_QUEBRAS = 100;
const TETO_REPARADAS = 100;

export function sha256hex(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

/** `hashLinha(l) = sha256hex(l.prevHash + canonicalize(omit(l, 'prevHash')))` (JCS, §4.6). */
export function hashLinha(l: Linha): string {
  return sha256hex(l.prevHash + jcs(omit(l, ['prevHash'])));
}

/** `ancora(manifesto) = sha256hex(canonicalize(manifesto))`: raiz da cadeia de um processo. */
export function ancora(manifesto: unknown): string {
  return sha256hex(jcs(manifesto));
}

// canonicalize devolve `string | undefined` só para entradas não serializáveis (function,
// symbol, undefined); Linha e o manifesto nunca são isso, mas o tipo exige o fallback.
function jcs(valor: unknown): string {
  return canonicalize(valor) ?? '';
}

/** Predicado único (escritor e verificador): a linha é um elo válido, ou `null`. */
export function eloValido(texto: string): Linha | null {
  try {
    const resultado = Linha.safeParse(JSON.parse(texto));
    return resultado.success ? resultado.data : null;
  } catch {
    return null;
  }
}

/** `prevHash` esperado do próximo elo, dado o último elo válido anterior (ou `null` = início da cadeia). */
export function prevHashEsperado(ultimoElo: Linha | null, manifesto: unknown): string {
  return isNil(ultimoElo) ? ancora(manifesto) : hashLinha(ultimoElo);
}

/** `seq` esperado do próximo elo: `n` = linhas não-elo (pendentes) desde o último elo (ou desde o início). */
export function proximoSeq(ultimoElo: Linha | null, n: number): number {
  return isNil(ultimoElo) ? n : ultimoElo.seq + 1 + n;
}

/**
 * Verifica a cadeia de hash de um log JSONL (§4.6). `validarDados`, quando informado, roda
 * sobre `{tipo, dados}` de cada elo e retorna `Detalhe[]` (reprovado) ou `null` (aprovado);
 * um retorno não nulo vira quebra `dados-invalidos`.
 */
export function verificarCadeia(
  texto: string,
  manifesto: unknown,
  validarDados?: (tipo: string, dados: Record<string, unknown>) => Detalhe[] | null,
): Cadeia {
  // A cauda sem '\n' (escrita em andamento, ou rasgo ainda não reparado) é ignorada:
  // split(-1) descarta o último elemento, terminado ou não.
  const linhas = texto.split('\n').slice(0, -1);

  let ultimoElo: Linha | null = null;
  let pendentes: number[] = [];
  const quebras: Quebra[] = [];
  const linhasReparadas: number[] = [];

  const resolverPendentes = (repara: boolean) => {
    if (repara) {
      linhasReparadas.push(...pendentes);
    } else {
      for (const indice of pendentes) quebras.push({ indice, motivo: 'linha-invalida' });
    }
    pendentes = [];
  };

  linhas.forEach((linha, indice) => {
    const elo = eloValido(linha);
    if (isNil(elo)) {
      pendentes.push(indice);
      return;
    }

    const seqOk = elo.seq === proximoSeq(ultimoElo, pendentes.length);
    const hashOk = elo.prevHash === prevHashEsperado(ultimoElo, manifesto);
    if (!seqOk) quebras.push({ indice, motivo: 'seq-divergente' });
    if (!hashOk) quebras.push({ indice, motivo: 'hash-nao-bate' });
    resolverPendentes(seqOk && hashOk);

    if (!isNil(validarDados) && !isNil(validarDados(elo.tipo, elo.dados))) {
      quebras.push({ indice, motivo: 'dados-invalidos' });
    }

    ultimoElo = elo;
  });
  resolverPendentes(false);

  quebras.sort((a, b) => a.indice - b.indice);

  return {
    ok: quebras.length === 0,
    totalLinhas: linhas.length,
    cabeca: isNil(ultimoElo) ? '' : hashLinha(ultimoElo),
    quebras: quebras.slice(0, TETO_QUEBRAS),
    totalQuebras: quebras.length,
    linhasReparadas: linhasReparadas.slice(0, TETO_REPARADAS),
  };
}
