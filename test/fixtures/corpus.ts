import * as fs from 'node:fs';
import { randomUUIDv7 } from 'node:crypto';
import { isNil } from 'es-toolkit';
import * as fc from 'fast-check';
import MiniSearch from 'minisearch';
import { expectedPrevHash, nextSeq } from '../../src/chain.ts';
import type { ProcessManifest, Vocabulary } from '../../src/definitions.ts';
import { stripDiacritics, indexableText } from '../../src/search.ts';
import type { EventLine } from '../../src/events.ts';

// Marcadas como "obrigatórias" pelo passo 7c (âncoras que os ACs M11/M12 exigem, sem depender
// da distribuição aleatória do gerador para aparecerem).
const FRASE_CACHE_INVALIDACAO_TRUE = 'cache invalidação aplicada corretamente nesta rodada';
const FRASE_CACHE_INVALIDADO_DECOY = 'cache invalidado no processo anterior';
const FRASE_CACHE_VALIDACAO_DECOY = 'validação de cache sem problemas registrados';
const FRASE_LOGIN = 'login realizado pelo usuário com sucesso';

// Banco geral: nunca contém a palavra "problema" junto de "webhook" (M11i depende disso).
const FRASES_GERAIS = [
  'revisão geral do processo concluída sem pendências',
  'nota registrada pelo agente responsável pela etapa',
  'verificação de rotina sem pendências encontradas',
  'ajuste de configuração aplicado com sucesso',
  'documentação interna atualizada nesta etapa',
  'houve um problema isolado no processamento geral',
];
const FRASES_AUTENTICACAO = [
  'processo de autenticação concluído com êxito',
  'falha na autenticação do usuário reportada',
  'autenticação de dois fatores habilitada',
];
const FRASES_PAGAMENTO = [
  'pagamento processado sem erros aparentes',
  'estorno de pagamento solicitado pelo cliente',
];
const FRASES_WEBHOOK = [
  'webhook recebido do parceiro externo',
  'webhook disparado para o sistema do cliente',
  'reenvio automático do webhook configurado',
];
const BANCO_FRASES = [
  ...FRASES_GERAIS,
  ...FRASES_AUTENTICACAO,
  ...FRASES_PAGAMENTO,
  ...FRASES_WEBHOOK,
];

const ALVOS_BASE = [
  'hex:target:conta-1',
  'hex:target:conta-2',
  'hex:target:pedido-1',
  'hex:target:pagamento-1',
  'hex:target:sessao-1',
];
const ALVOS_LOGIN = [
  'hex:target:login',
  'hex:target:login-1',
  'hex:target:login-2',
  'hex:target:login-3',
  'hex:target:login-4',
  'hex:target:login-5',
  'hex:target:login-6',
];
const ALVOS_DO_CORPUS = [...ALVOS_BASE, ...ALVOS_LOGIN];

type MilestoneIntent = {
  categoria: 'milestone';
  milestoneType: string;
  target: string;
  frase?: string;
  comContagem: boolean;
};
type VerdictIntent = { categoria: 'verdict'; target: string; result: string; frase: string };
type IntentoCustom = { categoria: 'custom'; frase: string; tag: string; alvoOculto?: string };
type Intento = MilestoneIntent | VerdictIntent | IntentoCustom;

function escolher<T>(lista: T[], padrao: T, indice: number): T {
  return lista.length > 0 ? lista[indice % lista.length] : padrao;
}

/** Eventos garantidos pelos ACs (M11c, M11i, M12a, M12b): não dependem da amostragem aleatória. */
function ancoras(vocabulary: Vocabulary): Intento[] {
  const milestoneType = escolher(vocabulary.core.milestoneType, 'aprovado', 0);
  const result = escolher(vocabulary.core.result, 'ok', 0);
  const comDecisao = (target: string, frase: string): MilestoneIntent => ({
    categoria: 'milestone',
    milestoneType,
    target,
    frase,
    comContagem: false,
  });

  return [
    comDecisao('hex:target:cache-1', FRASE_CACHE_INVALIDACAO_TRUE),
    comDecisao('hex:target:cache-2', FRASE_CACHE_INVALIDADO_DECOY),
    comDecisao('hex:target:cache-3', FRASE_CACHE_VALIDACAO_DECOY),
    { categoria: 'verdict', target: 'hex:target:login', result, frase: FRASE_LOGIN },
    { categoria: 'verdict', target: 'hex:target:login-1', result, frase: FRASE_LOGIN },
    {
      categoria: 'verdict',
      target: 'hex:target:conta-1',
      result: 'resultado-fora-do-vocabulario',
      frase: FRASES_GERAIS[0],
    },
    { categoria: 'verdict', target: 'hex:target:conta-2', result, frase: FRASES_WEBHOOK[0] },
    { categoria: 'verdict', target: 'hex:target:conta-3', result, frase: FRASES_WEBHOOK[1] },
    comDecisao('hex:target:conta-4', FRASES_WEBHOOK[2]),
  ];
}

type Rascunho = {
  categoria: 'milestone' | 'verdict' | 'custom';
  banco: number;
  alvoIndice: number;
  resultadoForaDoVocab: boolean;
  comDecisoes: boolean;
};

const RASCUNHO_ARB: fc.Arbitrary<Rascunho> = fc.record({
  categoria: fc.oneof(
    { weight: 4, arbitrary: fc.constant<'milestone'>('milestone') },
    { weight: 4, arbitrary: fc.constant<'verdict'>('verdict') },
    { weight: 2, arbitrary: fc.constant<'custom'>('custom') },
  ),
  banco: fc.nat({ max: 9999 }),
  alvoIndice: fc.nat({ max: 9999 }),
  resultadoForaDoVocab: fc.boolean(),
  comDecisoes: fc.boolean(),
});

function paraIntento(r: Rascunho, vocabulary: Vocabulary, indice: number): Intento {
  const target = ALVOS_DO_CORPUS[r.alvoIndice % ALVOS_DO_CORPUS.length];
  const frase = BANCO_FRASES[r.banco % BANCO_FRASES.length];

  if (r.categoria === 'milestone') {
    const milestoneType = escolher(vocabulary.core.milestoneType, 'aprovado', r.banco);
    return {
      categoria: 'milestone',
      milestoneType,
      target,
      frase: r.comDecisoes ? frase : undefined,
      comContagem: r.banco % 5 === 0,
    };
  }
  if (r.categoria === 'verdict') {
    const resultBase = escolher(vocabulary.core.result, 'ok', r.banco);
    const result = r.resultadoForaDoVocab ? `resultado-externo-${indice}` : resultBase;
    return { categoria: 'verdict', target, result, frase };
  }
  return {
    categoria: 'custom',
    frase,
    tag: `tag-${r.banco % 7}`,
    alvoOculto: r.banco % 11 === 0 ? target : undefined,
  };
}

function dadosDoIntento(intento: Intento): Record<string, unknown> {
  if (intento.categoria === 'milestone') {
    const data: Record<string, unknown> = {
      milestoneType: intento.milestoneType,
      target: intento.target,
    };
    if (intento.comContagem) data.count = { field: 'itens processados', value: 1 };
    if (!isNil(intento.frase))
      data.decisions = [{ item: 'item-1', action: 'seguir', text: intento.frase }];
    return data;
  }
  if (intento.categoria === 'verdict') {
    return {
      claim: intento.frase,
      source: 'corpus-fixture',
      result: intento.result,
      evidence: 'evidência gerada pelo corpus',
      target: intento.target,
      origin: 'gerarCorpus',
      trace: 'rastro-sintético',
    };
  }
  const data: Record<string, unknown> = {
    texto: intento.frase,
    detalhe: { nota: `observação sobre ${intento.tag}` },
    tags: [intento.tag, 'sintético'],
  };
  if (!isNil(intento.alvoOculto)) data.alvoRelacionado = intento.alvoOculto;
  return data;
}

function tipoDoIntento(intento: Intento, nomeTipoCustom: string): string {
  if (intento.categoria === 'milestone') return 'milestone';
  if (intento.categoria === 'verdict') return 'verdict';
  return nomeTipoCustom;
}

function montarLinhas(manifest: ProcessManifest, intentos: Intento[]): EventLine[] {
  const nomeTipoCustom = Object.keys(manifest.fixed.types)[0] ?? 'nota';
  const linhas: EventLine[] = [];
  let ultimoElo: EventLine | null = null;

  intentos.forEach((intento, indice) => {
    const tipo = tipoDoIntento(intento, nomeTipoCustom);
    const linha: EventLine = {
      seq: nextSeq(ultimoElo, 0),
      id: `${manifest.project}:${manifest.process}:${tipo}:${randomUUIDv7()}`,
      type: tipo,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, indice)).toISOString(),
      agent: 'agente-corpus',
      prevHash: expectedPrevHash(ultimoElo, manifest),
      data: dadosDoIntento(intento),
    };
    linhas.push(linha);
    ultimoElo = linha;
  });

  return linhas;
}

const TOKENIZAR = MiniSearch.getDefault('tokenize') as (texto: string) => string[];

/** Força bruta: índices cujo `indexableText` normalizado contém `termo` como prefixo de algum token. */
function gabaritoDeTermo(linhas: EventLine[], termo: string): number[] {
  const alvo = stripDiacritics(termo);
  return linhas
    .map((linha, indice) => ({
      indice,
      tokens: TOKENIZAR(indexableText(linha)).map(stripDiacritics),
    }))
    .filter(({ tokens }) => tokens.some((token: string) => token.startsWith(alvo)))
    .map(({ indice }) => indice);
}

/**
 * Gera um corpus determinístico (`fc.sample`, seed fixa) com cadeia de hash válida (`chain.ts`),
 * ~40% Milestone, ~40% Verdict, ~20% custom, mais as âncoras exigidas pelos ACs M11/M12 (§4.17, passo 7c).
 */
export function gerarCorpus(opcoes: {
  tamanho: number;
  seed?: number;
  manifesto: ProcessManifest;
  vocabulario: Vocabulary;
}): { linhas: EventLine[]; texto: string; gabarito: (termo: string) => number[] } {
  const { tamanho, seed = 42, manifesto, vocabulario } = opcoes;

  const fixas = ancoras(vocabulario);
  const rascunhos = fc.sample(RASCUNHO_ARB, { seed, numRuns: Math.max(0, tamanho - fixas.length) });
  const intentos = [...fixas, ...rascunhos.map((r, i) => paraIntento(r, vocabulario, i))];

  const linhas = montarLinhas(manifesto, intentos);
  const texto = `${linhas.map((linha) => JSON.stringify(linha)).join('\n')}\n`;

  return { linhas, texto, gabarito: (termo: string) => gabaritoDeTermo(linhas, termo) };
}

export function escreverCorpus(arquivo: string, texto: string): void {
  fs.writeFileSync(arquivo, texto);
}
