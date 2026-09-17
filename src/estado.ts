import { groupBy, isNil, keyBy, pick, uniqBy } from 'es-toolkit';
import { z } from 'zod';
import type { Cadeia } from './cadeia.ts';
import { Nome } from './eventos.ts';
import type { Linha } from './eventos.ts';

// §4.9: cada lista do vocabulário tem até 100 valores de até 100 caracteres.
const ValorVocabulario = z.string().min(1).max(100);
const ListaVocabulario = z.array(ValorVocabulario).max(100);

export const VocabSchema = z.strictObject({
  marcoTipo: ListaVocabulario,
  resultado: ListaVocabulario,
  acao: ListaVocabulario,
});
export type Vocab = z.infer<typeof VocabSchema>;

export const VocabularioSchema = z.strictObject({
  nucleo: VocabSchema,
  porDono: z.record(Nome, VocabSchema),
});
export type Vocabulario = z.infer<typeof VocabularioSchema>;

export type CampoVocabulario = 'marcoTipo' | 'resultado' | 'decisoes.acao';

export type VigenciaPorChave =
  | { destino: string; afirmacao: string; status: 'vigente'; vigente: string }
  | { destino: string; afirmacao: string; status: 'conflito'; candidatos: string[] };

export type Projecao = {
  logAte: { id: string; seq: number; timestamp: string } | null;
  vigentes: VigenciaPorChave[]; // ordem de 1ª aparição
  conflitos: { destino: string; afirmacao: string; candidatos: string[] }[];
  orfaos: { marco: string; alvo: string; prazoExecucao: string }[];
  aRevisar: string[];
  referenciasInvalidas: { citadaPor: string; referencia: string }[];
  avisos: {
    evento: string;
    campo: CampoVocabulario;
    valor: string;
    classe: 'extensao' | 'aviso-desconhecido' | 'erro';
    dono: string | null;
  }[];
};

export type Estado = Projecao & { cadeia: Cadeia };

/** `agora` efetivo da projeção (Q10): o mais recente entre o relógio injetado e o último elo do log. */
export function agoraEfetivo(relogio: string, elos: Linha[]): string {
  const ultimo = elos.at(-1);
  if (isNil(ultimo)) return relogio;
  // Instante (ISO 8601 UTC "Z") ordena igual por comparação lexicográfica; es-toolkit.maxBy
  // compara numericamente e erraria aqui, por isso o ternário em vez do helper.
  return relogio > ultimo.timestamp ? relogio : ultimo.timestamp;
}

// Forma de leitura de `dados` já validado (normalizarDados): cobre Marco e a variante gate
// (que não tem `prazoExecucao`/`decisoes`), e Veredito. Sem revalidação — só acesso a campo.
type CampoMarco = {
  marcoTipo: string;
  alvo: string;
  prazoExecucao?: string;
  decisoes?: { item: string; acao: string; texto: string }[];
};
type CampoVeredito = {
  destino: string;
  afirmacao: string;
  resultado: string;
  supera?: string[];
};

function alvoDe(elo: Linha): string | undefined {
  if (elo.tipo === 'marco') return (elo.dados as CampoMarco).alvo;
  if (elo.tipo === 'veredito') return (elo.dados as CampoVeredito).destino;
  return undefined; // tipos custom não têm alvo e são inertes (S3)
}

function ehMarcoGate(elo: Linha): boolean {
  return elo.tipo === 'marco' && (elo.dados as CampoMarco).marcoTipo === 'gate';
}

function chaveDeAgrupamento(dados: CampoVeredito): string {
  return JSON.stringify([dados.destino, dados.afirmacao]);
}

type ResultadoSupersessao = {
  vigentes: VigenciaPorChave[];
  conflitos: Projecao['conflitos'];
  referenciasInvalidas: Projecao['referenciasInvalidas'];
  superadas: Linha[];
};

/** Vigentes/conflitos/referenciasInvalidas por (destino, afirmação); `supera` marca superados sem fundir grupos. */
function computarSupersessao(vereditos: Linha[]): ResultadoSupersessao {
  const vereditoPorId = keyBy(vereditos, (v) => v.id);
  const superado = new Set<string>();
  const referenciasInvalidas: Projecao['referenciasInvalidas'] = [];

  for (const v of vereditos) {
    const dados = v.dados as CampoVeredito;
    for (const refId of dados.supera ?? []) {
      if (isNil(vereditoPorId[refId])) {
        referenciasInvalidas.push({ citadaPor: v.id, referencia: refId });
        continue;
      }
      superado.add(refId);
    }
  }

  const porChave = groupBy(vereditos, (v) => chaveDeAgrupamento(v.dados as CampoVeredito));

  const vigentes: VigenciaPorChave[] = [];
  const conflitos: Projecao['conflitos'] = [];
  for (const [chave, membros] of Object.entries(porChave)) {
    const candidatos = membros.filter((v) => !superado.has(v.id)).map((v) => v.id);
    if (candidatos.length === 0) continue; // grupo inteiro superado por vereditos de outra chave: sem vigente

    const [destino, afirmacao] = JSON.parse(chave) as [string, string];
    if (candidatos.length === 1) {
      vigentes.push({ destino, afirmacao, status: 'vigente', vigente: candidatos[0] });
      continue;
    }
    vigentes.push({ destino, afirmacao, status: 'conflito', candidatos });
    conflitos.push({ destino, afirmacao, candidatos });
  }

  const superadas = vereditos.filter((v) => superado.has(v.id));
  return { vigentes, conflitos, referenciasInvalidas, superadas };
}

/** Ciclo do Marco por alvo (§4.8, pseudocódigo do plano): reduce puro, gate nunca abre nem fecha (R-3). */
function derivarCiclo(eventosDoAlvo: Linha[]): { abertura: Linha; fechado: boolean } | undefined {
  type Acc = { abertura?: Linha; fechado: boolean };
  const final = eventosDoAlvo.reduce<Acc>(
    (acc, e) => {
      if (ehMarcoGate(e)) return acc;
      const prazoExecucao = e.tipo === 'marco' ? (e.dados as CampoMarco).prazoExecucao : undefined;
      if (!isNil(prazoExecucao)) return { abertura: e, fechado: false }; // nova abertura reinicia
      return isNil(acc.abertura) ? acc : { ...acc, fechado: true }; // qualquer evento posterior fecha
    },
    { fechado: false },
  );

  return isNil(final.abertura) ? undefined : { abertura: final.abertura, fechado: final.fechado };
}

function calcularOrfaos(elos: Linha[], agora: string): Projecao['orfaos'] {
  const comAlvo = elos.filter((e) => e.tipo === 'marco' || e.tipo === 'veredito');
  const porAlvo = groupBy(comAlvo, (e) => alvoDe(e) as string);

  const orfaos: Projecao['orfaos'] = [];
  for (const [alvo, eventosDoAlvo] of Object.entries(porAlvo)) {
    const ciclo = derivarCiclo(eventosDoAlvo);
    if (isNil(ciclo) || ciclo.fechado) continue;

    const prazoExecucao = (ciclo.abertura.dados as CampoMarco).prazoExecucao;
    if (!isNil(prazoExecucao) && prazoExecucao < agora) {
      orfaos.push({ marco: ciclo.abertura.id, alvo, prazoExecucao });
    }
  }
  return orfaos;
}

/** BFS por alvo a partir dos Vereditos superados; Marcos de gate entram (só ficam fora do ciclo, R-3). */
function calcularARevisar(elos: Linha[], superadas: Linha[]): string[] {
  const porId = keyBy(elos, (e) => e.id);
  const idsSuperados = new Set(superadas.map((v) => v.id));
  const alvosVisitados = new Set<string>();
  const fila: string[] = [];

  for (const veredito of superadas) {
    const alvo = alvoDe(veredito);
    if (isNil(alvo) || alvosVisitados.has(alvo)) continue;
    alvosVisitados.add(alvo);
    fila.push(alvo);
  }

  const resultado: string[] = [];
  while (fila.length > 0) {
    const alvo = fila.shift();
    if (isNil(alvo)) continue;

    for (const elo of elos) {
      if (alvoDe(elo) !== alvo || idsSuperados.has(elo.id)) continue;
      resultado.push(elo.id);

      if (elo.tipo !== 'veredito') continue;
      for (const refId of (elo.dados as CampoVeredito).supera ?? []) {
        const referenciado = porId[refId];
        if (isNil(referenciado)) continue;
        const alvoReferenciado = alvoDe(referenciado);
        if (isNil(alvoReferenciado) || alvosVisitados.has(alvoReferenciado)) continue;
        alvosVisitados.add(alvoReferenciado);
        fila.push(alvoReferenciado);
      }
    }
  }
  return resultado;
}

type PoliticaCampo = { chave: keyof Vocab; aberto: boolean };

// aberto=true: fora de núcleo ∪ extensões vira aviso (campo aberto); aberto=false: vira erro (campo fechado).
const POLITICA_POR_CAMPO: Record<CampoVocabulario, PoliticaCampo> = {
  marcoTipo: { chave: 'marcoTipo', aberto: false },
  resultado: { chave: 'resultado', aberto: true },
  'decisoes.acao': { chave: 'acao', aberto: false },
};

/** Classifica `valor` de `campo` contra o vocabulário (§4.9). `null` = valor do núcleo, sem aviso. */
export function validarCampo(
  vocabulario: Vocabulario,
  campo: CampoVocabulario,
  valor: string,
): { classe: 'extensao' | 'aviso-desconhecido' | 'erro'; dono: string | null } | null {
  const { chave, aberto } = POLITICA_POR_CAMPO[campo];

  if (vocabulario.nucleo[chave].includes(valor)) return null;

  const donos = Object.entries(vocabulario.porDono)
    .filter(([, vocab]) => vocab[chave].includes(valor))
    .map(([dono]) => dono);

  if (donos.length === 1) return { classe: 'extensao', dono: donos[0] };
  if (donos.length > 1) return { classe: 'extensao', dono: null }; // dois+ donos declaram o mesmo valor: ambíguo

  return { classe: aberto ? 'aviso-desconhecido' : 'erro', dono: null };
}

function coletarAvisos(elos: Linha[], vocabulario: Vocabulario): Projecao['avisos'] {
  const avisos: Projecao['avisos'] = [];

  const registrar = (evento: string, campo: CampoVocabulario, valor: string): void => {
    const resultado = validarCampo(vocabulario, campo, valor);
    if (isNil(resultado)) return;
    avisos.push({ evento, campo, valor, ...resultado });
  };

  for (const elo of elos) {
    if (elo.tipo === 'marco') {
      if (ehMarcoGate(elo)) continue; // §4.9: Marcos de gate são ignorados
      const dados = elo.dados as CampoMarco;
      registrar(elo.id, 'marcoTipo', dados.marcoTipo);
      for (const decisao of dados.decisoes ?? []) registrar(elo.id, 'decisoes.acao', decisao.acao);
    } else if (elo.tipo === 'veredito') {
      registrar(elo.id, 'resultado', (elo.dados as CampoVeredito).resultado);
    }
  }
  return avisos;
}

/**
 * Projeta o Estado a partir dos elos (§4.8), pura: full rebuild sempre a partir do array
 * completo, nunca incremental. Recebe só elos com `dados` já validado (normalizarDados) e
 * `agora` já resolvido por `agoraEfetivo` (Q10).
 */
export function projetar(elos: Linha[], vocabulario: Vocabulario, agora: string): Projecao {
  const deduplicados = uniqBy(elos, (e) => e.id); // primeira ocorrência vence
  const ultimo = deduplicados.at(-1);

  const vereditos = deduplicados.filter((e) => e.tipo === 'veredito');
  const { vigentes, conflitos, referenciasInvalidas, superadas } = computarSupersessao(vereditos);

  return {
    logAte: isNil(ultimo) ? null : pick(ultimo, ['id', 'seq', 'timestamp']),
    vigentes,
    conflitos,
    orfaos: calcularOrfaos(deduplicados, agora),
    aRevisar: calcularARevisar(deduplicados, superadas),
    referenciasInvalidas,
    avisos: coletarAvisos(deduplicados, vocabulario),
  };
}
