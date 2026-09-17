import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import type { Linha } from '../src/eventos.ts';
import { agoraEfetivo, projetar, type Vocabulario } from '../src/estado.ts';

// ---- fixtures locais (duplicadas de estado.spec.ts: 2 arquivos só, sem 3º módulo) ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const AGORA_BASE = T(0);
const vocabularioVazio: Vocabulario = { nucleo: { marcoTipo: [], resultado: [], acao: [] }, porDono: {} };

function elo(args: {
  tipo: string;
  dados: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): Linha {
  const numeroSeq = args.seq ?? 0;
  return {
    seq: numeroSeq,
    id: args.id ?? `p:r:${args.tipo}:${randomUUIDv7()}`,
    tipo: args.tipo,
    timestamp: args.timestamp ?? T(numeroSeq),
    agente: 'teste',
    prevHash: '0'.repeat(64), // sintético: a projeção não verifica hash
    dados: args.dados,
  };
}

function marco(dados: { alvo: string }, opcoes: { id?: string; timestamp?: string; seq?: number } = {}): Linha {
  return elo({ tipo: 'marco', dados: { marcoTipo: 'evento-property', ...dados }, ...opcoes });
}

function veredito(
  dados: { destino: string; afirmacao: string; supera?: string[] },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): Linha {
  return elo({
    tipo: 'veredito',
    dados: { fonte: 'f', prova: 'p', origem: 'o', rastro: 'r', resultado: 'confirmada', ...dados },
    ...opcoes,
  });
}

// ---- gerador de intents (porte de evolve.property.spec.ts:26-67, ids/alvos no formato novo) ----

const ALVO_A = 'hex:alvo:a';
const ALVO_B = 'hex:alvo:b';

interface IntentoVeredito {
  readonly tipo: 'veredito';
  readonly destino: string;
  readonly afirmacao: 'a1' | 'a2';
  readonly superaOffset: number | null;
}
interface IntentoMarco {
  readonly tipo: 'marco';
  readonly alvo: string;
}
type Intento = IntentoVeredito | IntentoMarco;

const arbitrarioIntento: fc.Arbitrary<Intento> = fc.oneof(
  fc.record({
    tipo: fc.constant('veredito' as const),
    destino: fc.constantFrom(ALVO_A, ALVO_B),
    afirmacao: fc.constantFrom('a1' as const, 'a2' as const),
    superaOffset: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
  }),
  fc.record({ tipo: fc.constant('marco' as const), alvo: fc.constantFrom(ALVO_A, ALVO_B) }),
);

const arbitrarioSequencia = fc.array(arbitrarioIntento, { minLength: 1, maxLength: 12 });

/** Materializa a sequência de intenções em elos: timestamps crescentes, ids únicos por índice,
 * `supera` resolvido só contra vereditos anteriores (nunca referencia algo à frente no log). */
function materializar(intentos: readonly Intento[]): Linha[] {
  const idPorIndice: string[] = [];
  const tipoPorIndice: Intento['tipo'][] = [];

  return intentos.map((intento, indice) => {
    const timestamp = T(indice);
    const id = `p:r:${intento.tipo}:${randomUUIDv7()}`;
    idPorIndice.push(id);
    tipoPorIndice.push(intento.tipo);

    if (intento.tipo === 'marco') return marco({ alvo: intento.alvo }, { id, timestamp, seq: indice });

    let supera: string[] | undefined;
    if (intento.superaOffset !== null) {
      const alvoIndice = indice - intento.superaOffset;
      if (alvoIndice >= 0 && tipoPorIndice[alvoIndice] === 'veredito') supera = [idPorIndice[alvoIndice]];
    }
    return veredito({ destino: intento.destino, afirmacao: intento.afirmacao, supera }, { id, timestamp, seq: indice });
  });
}

describe('projetar — propriedades (fast-check)', () => {
  test('para qualquer sequência válida, projetar nunca lança e toda vigência é única ou conflito com 2+ candidatos', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, (intentos) => {
        const elos = materializar(intentos);
        const projecao = projetar(elos, vocabularioVazio, agoraEfetivo(AGORA_BASE, elos));

        for (const vigencia of projecao.vigentes) {
          if (vigencia.status === 'vigente') expect(vigencia.vigente).toBeTruthy();
          else expect(vigencia.candidatos.length).toBeGreaterThanOrEqual(2);
        }
      }),
    );
  });

  test('reinserir ao final uma duplicata de um elo já existente não muda a Projeção (idempotência de dedupe)', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, fc.nat(), (intentos, indiceBruto) => {
        const elos = materializar(intentos);
        const indice = indiceBruto % elos.length;
        const duplicata = elos[indice];
        const comDuplicata = [...elos, duplicata];
        const agora = agoraEfetivo(AGORA_BASE, elos);

        expect(projetar(comDuplicata, vocabularioVazio, agora)).toEqual(projetar(elos, vocabularioVazio, agora));
      }),
    );
  });

  test('vigentes aparece na ordem de 1ª aparição da chave (destino, afirmação) no log', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, (intentos) => {
        const elos = materializar(intentos);
        const projecao = projetar(elos, vocabularioVazio, agoraEfetivo(AGORA_BASE, elos));

        const ordemNoLog: string[] = [];
        for (const e of elos) {
          if (e.tipo !== 'veredito') continue;
          const dados = e.dados as { destino: string; afirmacao: string };
          const chave = JSON.stringify([dados.destino, dados.afirmacao]);
          if (!ordemNoLog.includes(chave)) ordemNoLog.push(chave);
        }

        const ordemObtida = projecao.vigentes.map((v) => JSON.stringify([v.destino, v.afirmacao]));
        // grupos inteiramente superados por outra chave somem de vigentes (não fundem, só desaparecem):
        // a ordem relativa entre as chaves que sobraram é a propriedade garantida.
        expect(ordemObtida).toEqual(ordemNoLog.filter((chave) => ordemObtida.includes(chave)));
      }),
    );
  });
});
