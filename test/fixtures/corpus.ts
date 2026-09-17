import * as fs from 'node:fs';
import { randomUUIDv7 } from 'node:crypto';
import { isNil } from 'es-toolkit';
import * as fc from 'fast-check';
import MiniSearch from 'minisearch';
import { ancora, prevHashEsperado, proximoSeq } from '../../src/cadeia.ts';
import type { Manifesto, Vocabulario } from '../../src/definicoes.ts';
import { semAcento, textoIndexavel } from '../../src/busca.ts';
import type { Linha } from '../../src/eventos.ts';

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
const FRASES_PAGAMENTO = ['pagamento processado sem erros aparentes', 'estorno de pagamento solicitado pelo cliente'];
const FRASES_WEBHOOK = [
  'webhook recebido do parceiro externo',
  'webhook disparado para o sistema do cliente',
  'reenvio automático do webhook configurado',
];
const BANCO_FRASES = [...FRASES_GERAIS, ...FRASES_AUTENTICACAO, ...FRASES_PAGAMENTO, ...FRASES_WEBHOOK];

const ALVOS_BASE = ['hex:alvo:conta-1', 'hex:alvo:conta-2', 'hex:alvo:pedido-1', 'hex:alvo:pagamento-1', 'hex:alvo:sessao-1'];
const ALVOS_LOGIN = ['hex:alvo:login', 'hex:alvo:login-1', 'hex:alvo:login-2', 'hex:alvo:login-3', 'hex:alvo:login-4', 'hex:alvo:login-5', 'hex:alvo:login-6'];
const ALVOS_DO_CORPUS = [...ALVOS_BASE, ...ALVOS_LOGIN];

type IntentoMarco = { categoria: 'marco'; marcoTipo: string; alvo: string; frase?: string; comContagem: boolean };
type IntentoVeredito = { categoria: 'veredito'; destino: string; resultado: string; frase: string };
type IntentoCustom = { categoria: 'custom'; frase: string; tag: string; alvoOculto?: string };
type Intento = IntentoMarco | IntentoVeredito | IntentoCustom;

function escolher<T>(lista: T[], padrao: T, indice: number): T {
  return lista.length > 0 ? lista[indice % lista.length]! : padrao;
}

/** Eventos garantidos pelos ACs (M11c, M11i, M12a, M12b): não dependem da amostragem aleatória. */
function ancoras(vocabulario: Vocabulario): Intento[] {
  const marcoTipo = escolher(vocabulario.nucleo.marcoTipo, 'aprovado', 0);
  const resultado = escolher(vocabulario.nucleo.resultado, 'ok', 0);
  const comDecisao = (alvo: string, frase: string): IntentoMarco => ({ categoria: 'marco', marcoTipo, alvo, frase, comContagem: false });

  return [
    comDecisao('hex:alvo:cache-1', FRASE_CACHE_INVALIDACAO_TRUE),
    comDecisao('hex:alvo:cache-2', FRASE_CACHE_INVALIDADO_DECOY),
    comDecisao('hex:alvo:cache-3', FRASE_CACHE_VALIDACAO_DECOY),
    { categoria: 'veredito', destino: 'hex:alvo:login', resultado, frase: FRASE_LOGIN },
    { categoria: 'veredito', destino: 'hex:alvo:login-1', resultado, frase: FRASE_LOGIN },
    { categoria: 'veredito', destino: 'hex:alvo:conta-1', resultado: 'resultado-fora-do-vocabulario', frase: FRASES_GERAIS[0]! },
    { categoria: 'veredito', destino: 'hex:alvo:conta-2', resultado, frase: FRASES_WEBHOOK[0]! },
    { categoria: 'veredito', destino: 'hex:alvo:conta-3', resultado, frase: FRASES_WEBHOOK[1]! },
    comDecisao('hex:alvo:conta-4', FRASES_WEBHOOK[2]!),
  ];
}

type Rascunho = {
  categoria: 'marco' | 'veredito' | 'custom';
  banco: number;
  alvoIndice: number;
  resultadoForaDoVocab: boolean;
  comDecisoes: boolean;
};

const RASCUNHO_ARB: fc.Arbitrary<Rascunho> = fc.record({
  categoria: fc.oneof(
    { weight: 4, arbitrary: fc.constant<'marco'>('marco') },
    { weight: 4, arbitrary: fc.constant<'veredito'>('veredito') },
    { weight: 2, arbitrary: fc.constant<'custom'>('custom') },
  ),
  banco: fc.nat({ max: 9999 }),
  alvoIndice: fc.nat({ max: 9999 }),
  resultadoForaDoVocab: fc.boolean(),
  comDecisoes: fc.boolean(),
});

function paraIntento(r: Rascunho, vocabulario: Vocabulario, indice: number): Intento {
  const alvo = ALVOS_DO_CORPUS[r.alvoIndice % ALVOS_DO_CORPUS.length]!;
  const frase = BANCO_FRASES[r.banco % BANCO_FRASES.length]!;

  if (r.categoria === 'marco') {
    const marcoTipo = escolher(vocabulario.nucleo.marcoTipo, 'aprovado', r.banco);
    return { categoria: 'marco', marcoTipo, alvo, frase: r.comDecisoes ? frase : undefined, comContagem: r.banco % 5 === 0 };
  }
  if (r.categoria === 'veredito') {
    const resultadoBase = escolher(vocabulario.nucleo.resultado, 'ok', r.banco);
    const resultado = r.resultadoForaDoVocab ? `resultado-externo-${indice}` : resultadoBase;
    return { categoria: 'veredito', destino: alvo, resultado, frase };
  }
  return {
    categoria: 'custom',
    frase,
    tag: `tag-${r.banco % 7}`,
    alvoOculto: r.banco % 11 === 0 ? alvo : undefined,
  };
}

function dadosDoIntento(intento: Intento): Record<string, unknown> {
  if (intento.categoria === 'marco') {
    const dados: Record<string, unknown> = { marcoTipo: intento.marcoTipo, alvo: intento.alvo };
    if (intento.comContagem) dados.contagem = { campo: 'itens processados', valor: 1 };
    if (!isNil(intento.frase)) dados.decisoes = [{ item: 'item-1', acao: 'seguir', texto: intento.frase }];
    return dados;
  }
  if (intento.categoria === 'veredito') {
    return {
      afirmacao: intento.frase,
      fonte: 'corpus-fixture',
      resultado: intento.resultado,
      prova: 'evidência gerada pelo corpus',
      destino: intento.destino,
      origem: 'gerarCorpus',
      rastro: 'rastro-sintético',
    };
  }
  const dados: Record<string, unknown> = {
    texto: intento.frase,
    detalhe: { nota: `observação sobre ${intento.tag}` },
    tags: [intento.tag, 'sintético'],
  };
  if (!isNil(intento.alvoOculto)) dados.alvoRelacionado = intento.alvoOculto;
  return dados;
}

function tipoDoIntento(intento: Intento, nomeTipoCustom: string): string {
  if (intento.categoria === 'marco') return 'marco';
  if (intento.categoria === 'veredito') return 'veredito';
  return nomeTipoCustom;
}

function montarLinhas(manifesto: Manifesto, intentos: Intento[]): Linha[] {
  const nomeTipoCustom = Object.keys(manifesto.fixado.tipos)[0] ?? 'nota';
  const linhas: Linha[] = [];
  let ultimoElo: Linha | null = null;

  intentos.forEach((intento, indice) => {
    const tipo = tipoDoIntento(intento, nomeTipoCustom);
    const linha: Linha = {
      seq: proximoSeq(ultimoElo, 0),
      id: `${manifesto.projeto}:${manifesto.processo}:${tipo}:${randomUUIDv7()}`,
      tipo,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, indice)).toISOString(),
      agente: 'agente-corpus',
      prevHash: prevHashEsperado(ultimoElo, manifesto),
      dados: dadosDoIntento(intento),
    };
    linhas.push(linha);
    ultimoElo = linha;
  });

  return linhas;
}

const TOKENIZAR = MiniSearch.getDefault('tokenize') as (texto: string) => string[];

/** Força bruta: índices cujo `textoIndexavel` normalizado contém `termo` como prefixo de algum token. */
function gabaritoDeTermo(linhas: Linha[], termo: string): number[] {
  const alvo = semAcento(termo);
  return linhas
    .map((linha, indice) => ({ indice, tokens: TOKENIZAR(textoIndexavel(linha)).map(semAcento) }))
    .filter(({ tokens }) => tokens.some((token) => token.startsWith(alvo)))
    .map(({ indice }) => indice);
}

/**
 * Gera um corpus determinístico (`fc.sample`, seed fixa) com cadeia de hash válida (`cadeia.ts`),
 * ~40% Marco, ~40% Veredito, ~20% custom, mais as âncoras exigidas pelos ACs M11/M12 (§4.17, passo 7c).
 */
export function gerarCorpus(opcoes: {
  tamanho: number;
  seed?: number;
  manifesto: Manifesto;
  vocabulario: Vocabulario;
}): { linhas: Linha[]; texto: string; gabarito: (termo: string) => number[] } {
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
