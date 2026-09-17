import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buscar } from '../src/busca.ts';
import type { Manifesto } from '../src/definicoes.ts';
import { escreverCorpus, gerarCorpus } from './fixtures/corpus.ts';
import { type Ambiente, criarAmbiente } from './helpers.ts';

const PROJ = 'orcamento';
const PROC = 'proc1';
const TAMANHO = 10_000;

/** Fixa vocabulário núcleo + um tipo custom e cria o processo; devolve o manifesto real gravado. */
async function prepararProcesso(ambiente: Ambiente): Promise<Manifesto> {
  await ambiente.chamar('registrar_vocabulario', {
    projeto: PROJ,
    dono: 'nucleo',
    marcoTipo: ['aprovado'],
    resultado: ['ok'],
    acao: ['seguir'],
  });
  await ambiente.chamar('registrar_tipo', {
    projeto: PROJ,
    nome: 'nota',
    schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'], additionalProperties: false },
  });
  await ambiente.chamar('criar_processo', { projeto: PROJ, processo: PROC });
  const conteudo = fs.readFileSync(path.join(ambiente.dir, PROJ, PROC, 'processo.json'), 'utf8');
  return JSON.parse(conteudo) as Manifesto;
}

function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 0 ? (ordenados[meio - 1]! + ordenados[meio]!) / 2 : ordenados[meio]!;
}

describe('M13', () => {
  test(
    'orçamento: índice (construção + consulta) ≤ 500 ms e eventos{busca} completo ≤ 2000 ms (medianas de 5, corpus de 10 000)',
    async () => {
      const ambiente = await criarAmbiente();
      try {
        const manifesto = await prepararProcesso(ambiente);
        const corpus = gerarCorpus({ tamanho: TAMANHO, manifesto, vocabulario: manifesto.fixado.vocabulario });
        escreverCorpus(path.join(ambiente.dir, PROJ, PROC, 'eventos.jsonl'), corpus.texto);

        const candidatos = corpus.linhas.map((linha, indice) => ({ indice, linha }));
        const temposIndice = Array.from({ length: 5 }, () => {
          const inicio = performance.now();
          buscar(candidatos, 'webhook');
          return performance.now() - inicio;
        });

        const temposChamada: number[] = [];
        for (let i = 0; i < 5; i++) {
          const inicio = performance.now();
          const resultado = await ambiente.chamar('eventos', { projeto: PROJ, processo: PROC, busca: 'webhook', limite: 50 });
          temposChamada.push(performance.now() - inicio);
          expect(resultado.isError).not.toBe(true);
        }

        const medianaIndice = mediana(temposIndice);
        const medianaChamada = mediana(temposChamada);
        process.stdout.write(`M13 mediana índice (construção+consulta): ${medianaIndice.toFixed(2)} ms\n`);
        process.stdout.write(`M13 mediana chamada completa eventos{busca}: ${medianaChamada.toFixed(2)} ms\n`);

        expect(medianaIndice).toBeLessThanOrEqual(500);
        expect(medianaChamada).toBeLessThanOrEqual(2000);
      } finally {
        await ambiente.fechar();
      }
    },
    60_000,
  );
});
