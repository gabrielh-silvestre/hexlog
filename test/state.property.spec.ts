import { describe, test, expect } from '@jest/globals';
import { randomUUIDv7 } from 'node:crypto';
import fc from 'fast-check';
import type { EventLine } from '../src/events.ts';
import { effectiveNow, projectState, type Vocabulary } from '../src/state.ts';

// ---- fixtures locais (duplicadas de state.spec.ts: 2 arquivos só, sem 3º módulo) ----

const T = (n: number) => new Date(n * 60_000).toISOString();
const AGORA_BASE = T(0);
const vocabularioVazio: Vocabulary = {
  core: { milestoneType: [], result: [], action: [] },
  byOwner: {},
};

function line(args: {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  seq?: number;
}): EventLine {
  const numeroSeq = args.seq ?? 0;
  return {
    seq: numeroSeq,
    id: args.id ?? `p:r:${args.type}:${randomUUIDv7()}`,
    type: args.type,
    timestamp: args.timestamp ?? T(numeroSeq),
    agent: 'teste',
    prevHash: '0'.repeat(64), // sintético: a projeção não verifica hash
    data: args.data,
  };
}

function milestone(
  data: { target: string },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  return line({
    type: 'milestone',
    data: { milestoneType: 'evento-property', ...data },
    ...opcoes,
  });
}

function verdict(
  data: { target: string; claim: string; supersedes?: string[] },
  opcoes: { id?: string; timestamp?: string; seq?: number } = {},
): EventLine {
  return line({
    type: 'verdict',
    data: { source: 'f', evidence: 'p', origin: 'o', trace: 'r', result: 'confirmada', ...data },
    ...opcoes,
  });
}

// ---- gerador de intents (porte de evolve.property.spec.ts:26-67, ids/alvos no formato novo) ----

const ALVO_A = 'hex:target:a';
const ALVO_B = 'hex:target:b';

interface IntentoVeredito {
  readonly tipo: 'verdict';
  readonly target: string;
  readonly claim: 'a1' | 'a2';
  readonly superaOffset: number | null;
}
interface IntentoMarco {
  readonly tipo: 'milestone';
  readonly target: string;
}
type Intento = IntentoVeredito | IntentoMarco;

const arbitrarioIntento: fc.Arbitrary<Intento> = fc.oneof(
  fc.record({
    tipo: fc.constant('verdict' as const),
    target: fc.constantFrom(ALVO_A, ALVO_B),
    claim: fc.constantFrom('a1' as const, 'a2' as const),
    superaOffset: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
  }),
  fc.record({ tipo: fc.constant('milestone' as const), target: fc.constantFrom(ALVO_A, ALVO_B) }),
);

const arbitrarioSequencia = fc.array(arbitrarioIntento, { minLength: 1, maxLength: 12 });

/** Materializa a sequência de intenções em lines: timestamps crescentes, ids únicos por índice,
 * `supersedes` resolvido só contra verdicts anteriores (nunca referencia algo à frente no log). */
function materializar(intentos: readonly Intento[]): EventLine[] {
  const idPorIndice: string[] = [];
  const tipoPorIndice: Intento['tipo'][] = [];

  return intentos.map((intento, indice) => {
    const timestamp = T(indice);
    const id = `p:r:${intento.tipo}:${randomUUIDv7()}`;
    idPorIndice.push(id);
    tipoPorIndice.push(intento.tipo);

    if (intento.tipo === 'milestone')
      return milestone({ target: intento.target }, { id, timestamp, seq: indice });

    let supersedes: string[] | undefined;
    if (intento.superaOffset !== null) {
      const alvoIndice = indice - intento.superaOffset;
      if (alvoIndice >= 0 && tipoPorIndice[alvoIndice] === 'verdict')
        supersedes = [idPorIndice[alvoIndice]];
    }
    return verdict(
      { target: intento.target, claim: intento.claim, supersedes },
      { id, timestamp, seq: indice },
    );
  });
}

describe('projetar — propriedades (fast-check)', () => {
  test('para qualquer sequência válida, projetar nunca lança e toda vigência é única ou conflito com 2+ candidatos', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, (intentos) => {
        const lines = materializar(intentos);
        const projecao = projectState(lines, vocabularioVazio, effectiveNow(AGORA_BASE, lines));

        for (const vigencia of projecao.active) {
          if (vigencia.status === 'active') expect(vigencia.active).toBeTruthy();
          else expect(vigencia.candidates.length).toBeGreaterThanOrEqual(2);
        }
      }),
    );
  });

  test('reinserir ao final uma duplicata de um elo já existente não muda a Projeção (idempotência de dedupe)', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, fc.nat(), (intentos, indiceBruto) => {
        const lines = materializar(intentos);
        const indice = indiceBruto % lines.length;
        const duplicata = lines[indice];
        const comDuplicata = [...lines, duplicata];
        const agora = effectiveNow(AGORA_BASE, lines);

        expect(projectState(comDuplicata, vocabularioVazio, agora)).toEqual(
          projectState(lines, vocabularioVazio, agora),
        );
      }),
    );
  });

  test('vigentes aparece na ordem de 1ª aparição da chave (destino, afirmação) no log', () => {
    fc.assert(
      fc.property(arbitrarioSequencia, (intentos) => {
        const lines = materializar(intentos);
        const projecao = projectState(lines, vocabularioVazio, effectiveNow(AGORA_BASE, lines));

        const ordemNoLog: string[] = [];
        for (const e of lines) {
          if (e.type !== 'verdict') continue;
          const data = e.data as { target: string; claim: string };
          const chave = JSON.stringify([data.target, data.claim]);
          if (!ordemNoLog.includes(chave)) ordemNoLog.push(chave);
        }

        const ordemObtida = projecao.active.map((v) => JSON.stringify([v.target, v.claim]));
        // grupos inteiramente superados por outra chave somem de active (não fundem, só desaparecem):
        // a ordem relativa entre as chaves que sobraram é a propriedade garantida.
        expect(ordemObtida).toEqual(ordemNoLog.filter((chave) => ordemObtida.includes(chave)));
      }),
    );
  });
});
