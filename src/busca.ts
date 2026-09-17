import { isNil, isString, orderBy, round } from 'es-toolkit';
import { isEmpty } from 'es-toolkit/compat';
import MiniSearch from 'minisearch';
import { ID_COMPLETO_RE, type Linha } from './eventos.ts';

/** Teto de caracteres do parâmetro `busca` de `eventos` (§4.16): abaixo de 2, `prefix` casaria quase tudo. */
export const TETO_BUSCA_CHARS = 200;

const DIACRITICOS_RE = /[̀-ͯ]/g;
const HEX_PREFIXO_RE = /^hex:/;

/** Remove acentos e normaliza para minúsculas (mesma função do probe da frente 15). */
export function semAcento(t: string): string {
  return t.normalize('NFD').replace(DIACRITICOS_RE, '').toLowerCase();
}

/** Texto livre indexável de uma linha (§4.17): campos por tipo, concatenados com `\n`; ids e endereços ficam fora. */
export function textoIndexavel(linha: Linha): string {
  if (linha.tipo === 'marco') {
    const dados = linha.dados as { marcoTipo?: string };
    return dados.marcoTipo === 'gate' ? textoDeGate(linha.dados) : textoDeMarco(linha.dados);
  }
  if (linha.tipo === 'veredito') return textoDeVeredito(linha.dados);
  return textoCustom(linha.dados);
}

function textoDeMarco(dados: Record<string, unknown>): string {
  const marco = dados as {
    marcoTipo?: string;
    contagem?: { campo?: string };
    decisoes?: { item: string; acao: string; texto: string }[];
  };
  const decisoes = (marco.decisoes ?? []).flatMap((decisao) => [decisao.item, decisao.acao, decisao.texto]);
  return [marco.marcoTipo, marco.contagem?.campo, ...decisoes].filter(isString).join('\n');
}

function textoDeGate(dados: Record<string, unknown>): string {
  const gate = dados as { gate?: { nome?: string; criterio?: string; prova?: unknown[] } };
  const itensDeProva = (gate.gate?.prova ?? []).filter(isString);
  return [gate.gate?.nome, gate.gate?.criterio, ...itensDeProva].filter(isString).join('\n');
}

function textoDeVeredito(dados: Record<string, unknown>): string {
  const veredito = dados as {
    afirmacao?: string;
    fonte?: string;
    resultado?: string;
    prova?: string | string[];
    origem?: string;
    rastro?: string;
  };
  const prova = isString(veredito.prova) ? [veredito.prova] : (veredito.prova ?? []).filter(isString);
  return [veredito.afirmacao, veredito.fonte, veredito.resultado, ...prova, veredito.origem, veredito.rastro]
    .filter(isString)
    .join('\n');
}

/** Tipo custom (§4.17): todo valor string em qualquer profundidade, exceto endereços `hex:` e ids completos. */
function textoCustom(dados: Record<string, unknown>): string {
  const partes: string[] = [];
  coletarStrings(dados, partes);
  return partes.join('\n');
}

function coletarStrings(valor: unknown, partes: string[]): void {
  if (isString(valor)) {
    if (!HEX_PREFIXO_RE.test(valor) && !ID_COMPLETO_RE.test(valor)) partes.push(valor);
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach((item) => coletarStrings(item, partes));
    return;
  }
  if (!isNil(valor) && typeof valor === 'object') {
    Object.values(valor).forEach((item) => coletarStrings(item, partes));
  }
}

/**
 * Filtros estruturados de `eventos` (§4.12 item 9): igualdade exata sobre `dados` cru, nunca via
 * índice de texto. `apos`/`antes` já normalizados (`new Date(v).toISOString()`) por quem chama.
 */
export type Filtros = {
  tipo?: string;
  alvo?: string;
  marcoTipo?: string;
  resultado?: string;
  apos?: string;
  antes?: string;
};

/** Uma linha é candidata quando satisfaz todos os filtros presentes (§4.12 item 9). */
export function ehCandidato(linha: Linha, filtros: Filtros): boolean {
  if (!isNil(filtros.tipo) && linha.tipo !== filtros.tipo) return false;
  if (!isNil(filtros.alvo) && !casaAlvo(linha, filtros.alvo)) return false;
  if (!isNil(filtros.marcoTipo) && !casaMarcoTipo(linha, filtros.marcoTipo)) return false;
  if (!isNil(filtros.resultado) && !casaResultado(linha, filtros.resultado)) return false;
  if (!isNil(filtros.apos) && linha.timestamp < filtros.apos) return false;
  if (!isNil(filtros.antes) && linha.timestamp >= filtros.antes) return false;
  return true;
}

function casaAlvo(linha: Linha, alvo: string): boolean {
  const dados = linha.dados as { alvo?: string; destino?: string };
  return dados.alvo === alvo || dados.destino === alvo;
}

function casaMarcoTipo(linha: Linha, marcoTipo: string): boolean {
  return linha.tipo === 'marco' && (linha.dados as { marcoTipo?: string }).marcoTipo === marcoTipo;
}

function casaResultado(linha: Linha, resultado: string): boolean {
  return linha.tipo === 'veredito' && (linha.dados as { resultado?: string }).resultado === resultado;
}

/** Quantidade de termos distintos de `busca` depois de tokenizar (padrão do MiniSearch) e aplicar `processTerm`. */
export function termosDistintos(busca: string): number {
  const tokenizar = MiniSearch.getDefault('tokenize') as (texto: string) => string[];
  const termos = tokenizar(busca).map(semAcento).filter((termo) => termo.length > 0);
  return new Set(termos).size;
}

type Candidato = { indice: number; linha: Linha };
type ResultadoBusca = { indice: number; relevancia: number };

/**
 * Índice MiniSearch (§4.17), construído só sobre `candidatos`, a cada chamada: config fixa
 * `AND` + `prefix` + `fuzzy: 0.1`, com fallback para `OR` quando o `AND` não devolve nada e a
 * consulta tem 2+ termos distintos.
 */
export function buscar(candidatos: Candidato[], busca: string): { resultados: ResultadoBusca[]; combinacao: 'AND' | 'OR' } {
  const motor = new MiniSearch<{ indice: number; texto: string }>({
    idField: 'indice',
    fields: ['texto'],
    processTerm: (t) => semAcento(t) || null,
    searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.1 },
  });
  motor.addAll(candidatos.map((c) => ({ indice: c.indice, texto: textoIndexavel(c.linha) })));

  let brutos = motor.search(busca);
  let combinacao: 'AND' | 'OR' = 'AND';
  if (isEmpty(brutos) && termosDistintos(busca) >= 2) {
    brutos = motor.search(busca, { combineWith: 'OR' });
    combinacao = 'OR';
  }

  const resultados = brutos.map((r) => ({ indice: r.id as number, relevancia: round(r.score, 4) }));
  return { resultados: orderBy(resultados, ['relevancia', 'indice'], ['desc', 'asc']), combinacao };
}
