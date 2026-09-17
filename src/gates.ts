import { isString } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat'; // isEmpty só existe em es-toolkit/compat (1.52.0)
import { z } from 'zod';
import { GATES_EMBUTIDOS_NOMES } from './dados.ts';
import { DadosMarcoGate as EsquemaDadosMarcoGate } from './eventos.ts';
import type { Estado } from './estado.ts';

// §4.16: tetos de prova de gate. Custom (TETO_PROVA_CUSTOM/TETO_ITEM_PROVA_CHARS) e
// TETO_CRITERIO_CHARS são validados no inputSchema da tool (passo 7b), não aqui.
export const TETO_PROVA_EMBUTIDO = 50;
export const TETO_PROVA_CUSTOM = 20;
export const TETO_ITEM_PROVA_CHARS = 2000;
export const TETO_CRITERIO_CHARS = 2000;

export type NomeGateEmbutido = (typeof GATES_EMBUTIDOS_NOMES)[number];

/** Forma canônica de `dados.gate` gravado pelo Marco de gate (§4.5/§4.11): nunca boolean solto. */
export type DadosMarcoGate = z.infer<typeof EsquemaDadosMarcoGate>;

export type ResultadoGate = {
  passou: boolean;
  prova: unknown[];
  totalItensProva: number;
  avaliadoAte: { id: string; seq: number; timestamp: string } | null;
};

type DefinicaoGateEmbutido = { criterio: string; itens: (estado: Estado) => unknown[] };

// §4.11: textos de `criterio` exatamente como a tabela do plano.
export const GATES_EMBUTIDOS: Record<NomeGateEmbutido, DefinicaoGateEmbutido> = {
  'sem-orfaos': {
    criterio:
      'estado.orfaos vazio: nenhum Marco com prazoExecucao < agora sem evento posterior no mesmo alvo',
    itens: (estado) => estado.orfaos,
  },
  'sem-conflitos': {
    criterio: 'estado.conflitos vazio: nenhuma (destino, afirmacao) com mais de um Veredito vigente',
    itens: (estado) => estado.conflitos,
  },
  'cadeia-integra': {
    criterio: 'cadeia.ok = true',
    itens: (estado) => estado.cadeia.quebras,
  },
  'sem-referencias-invalidas': {
    criterio: 'estado.referenciasInvalidas vazio: todo supera aponta para Veredito existente',
    itens: (estado) => estado.referenciasInvalidas,
  },
};

export function ehGateEmbutido(nome: string): nome is NomeGateEmbutido {
  return (GATES_EMBUTIDOS_NOMES as readonly string[]).includes(nome);
}

/** Avalia um gate embutido contra `estado` (§4.11): sem itens → passa; senão, corta a prova em 50. */
export function avaliarEmbutido(nome: NomeGateEmbutido, estado: Estado): ResultadoGate {
  const itens = GATES_EMBUTIDOS[nome].itens(estado);
  if (isEmpty(itens)) return { passou: true, prova: [], totalItensProva: 0, avaliadoAte: estado.logAte };

  return {
    passou: false,
    prova: itens.slice(0, TETO_PROVA_EMBUTIDO),
    totalItensProva: itens.length,
    avaliadoAte: estado.logAte,
  };
}

/** `prova` de gate custom, vinda do agente: string vira lista de um item. */
export function normalizarProvaCustom(prova: string | string[]): string[] {
  return isString(prova) ? [prova] : prova;
}

/** Monta e valida `DadosMarcoGate` (§4.5) para o Marco de gate, embutido ou custom. */
export function montarDadosMarcoGate(args: {
  nome: string;
  origem: 'embutido' | 'custom';
  criterio: string;
  alvo: string;
  resultado: ResultadoGate;
}): DadosMarcoGate {
  return EsquemaDadosMarcoGate.parse({
    marcoTipo: 'gate',
    alvo: args.alvo,
    gate: {
      nome: args.nome,
      origem: args.origem,
      criterio: args.criterio,
      passou: args.resultado.passou,
      prova: args.resultado.prova,
      totalItensProva: args.resultado.totalItensProva,
      avaliadoAte: args.resultado.avaliadoAte,
    },
  });
}

/** Para `listar.gatesEmbutidos`: nome e critério dos 4 gates embutidos. */
export function listarGatesEmbutidos(): { nome: string; criterio: string }[] {
  return GATES_EMBUTIDOS_NOMES.map((nome) => ({ nome, criterio: GATES_EMBUTIDOS[nome].criterio }));
}
