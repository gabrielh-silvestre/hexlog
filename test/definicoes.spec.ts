import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { sha256hex } from '../src/cadeia.ts';
import { caminho, PROCESSOS_RESERVADOS } from '../src/dados.ts';
import type { Manifesto } from '../src/definicoes.ts';
import {
  carregarProcesso,
  criarProcesso,
  lerProjeto,
  registrarGate,
  registrarTipo,
  registrarVocabulario,
} from '../src/definicoes.ts';
import { ErroHexlog } from '../src/erros.ts';
import { parseJson } from './helpers.ts';

const PROJETO = 'projeto-teste';
const SCHEMA_VALIDO = {
  type: 'object',
  properties: { texto: { type: 'string' } },
  required: ['texto'],
  additionalProperties: false,
};

// Forma de schemas/<nome>.json gravado por `registrarTipo` (S1).
const RegistroTipoSchema = z.object({
  nome: z.string(),
  schema: z.record(z.string(), z.unknown()),
  hash: z.string(),
  registradoEm: z.string(),
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definicoes-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Executa `fn`, afirma que lançou `ErroHexlog` e devolve o erro para asserções específicas. */
function capturarErro(fn: () => unknown): ErroHexlog {
  try {
    fn();
  } catch (erro) {
    expect(erro).toBeInstanceOf(ErroHexlog);
    return erro as ErroHexlog;
  }
  throw new Error('esperava que a função lançasse ErroHexlog');
}

/** Registra um núcleo de vocabulário mínimo e um schema custom, pré-requisito de `criarProcesso`. */
function prepararNucleoEUmSchema(): void {
  registrarVocabulario(dir, PROJETO, 'nucleo', { marcoTipo: ['revisao'], resultado: [], acao: [] });
  registrarTipo(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
}

function lerManifesto(processo: string): Manifesto {
  return JSON.parse(
    fs.readFileSync(path.join(dir, PROJETO, processo, 'processo.json'), 'utf8'),
  ) as Manifesto;
}

describe('registrarTipo (S1)', () => {
  test('grava schemas/<nome>.json com nome, schema, hash e registradoEm', () => {
    const resultado = registrarTipo(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
    const gravado = parseJson(
      RegistroTipoSchema,
      fs.readFileSync(caminho(dir, PROJETO, 'schemas', 'decisao.json'), 'utf8'),
    );
    expect(gravado).toEqual({
      nome: 'decisao',
      schema: SCHEMA_VALIDO,
      hash: resultado.hash,
      registradoEm: expect.any(String),
    });
  });

  test('rejeita $ref externo, sem gravar arquivo', () => {
    const erro = capturarErro(() => registrarTipo(dir, PROJETO, 'com-ref', { $ref: 'http://x/y' }));
    expect(erro.codigo).toBe('SCHEMA_INVALIDO');
    expect(fs.existsSync(caminho(dir, PROJETO, 'schemas', 'com-ref.json'))).toBe(false);
  });

  test.each(['marco', 'veredito'])('rejeita nome reservado "%s", sem gravar arquivo', (nome) => {
    const erro = capturarErro(() => registrarTipo(dir, PROJETO, nome, SCHEMA_VALIDO));
    expect(erro.codigo).toBe('NOME_RESERVADO');
    expect(fs.existsSync(caminho(dir, PROJETO, 'schemas', `${nome}.json`))).toBe(false);
  });
});

describe('registrarTipo — SCHEMA_INVALIDO sem gravar arquivo (S7)', () => {
  const CASOS: [string, Record<string, unknown>][] = [
    ['keyword com typo ("typ")', { type: 'object', typ: 'object' }],
    ['required malformado (string em vez de array)', { type: 'object', required: 'a' }],
    ['raiz não é "type": "object"', { type: 'string' }],
    [
      'if/then/else',
      {
        type: 'object',
        if: { properties: { a: { const: 1 } } },
        then: { required: ['b'] },
        else: { required: ['c'] },
      },
    ],
  ];

  test.each(CASOS)('%s → SCHEMA_INVALIDO', (_descricao, schema) => {
    const erro = capturarErro(() => registrarTipo(dir, PROJETO, 'tipo-invalido', schema));
    expect(erro.codigo).toBe('SCHEMA_INVALIDO');
    expect(fs.existsSync(caminho(dir, PROJETO, 'schemas', 'tipo-invalido.json'))).toBe(false);
  });

  test('schema com mais de 16 000 caracteres canônicos → SCHEMA_INVALIDO com detalhe too_big', () => {
    const schemaGigante = {
      type: 'object',
      properties: { texto: { type: 'string', description: 'x'.repeat(16_500) } },
    };
    const erro = capturarErro(() => registrarTipo(dir, PROJETO, 'tipo-gigante', schemaGigante));
    expect(erro.codigo).toBe('SCHEMA_INVALIDO');
    expect(erro.detalhes).toContainEqual(expect.objectContaining({ codigo: 'too_big' }));
    expect(fs.existsSync(caminho(dir, PROJETO, 'schemas', 'tipo-gigante.json'))).toBe(false);
  });
});

describe('criarProcesso / registrarGate — nomes reservados (S8)', () => {
  test.each(PROCESSOS_RESERVADOS)(
    'criarProcesso com processo="%s" → NOME_RESERVADO',
    (processo) => {
      const erro = capturarErro(() => criarProcesso(dir, PROJETO, processo, () => new Date()));
      expect(erro.codigo).toBe('NOME_RESERVADO');
    },
  );

  test('registrarGate com nome de gate embutido (sem-orfaos) → NOME_RESERVADO', () => {
    const erro = capturarErro(() => registrarGate(dir, PROJETO, 'sem-orfaos', 'critério qualquer'));
    expect(erro.codigo).toBe('NOME_RESERVADO');
  });
});

describe('criarProcesso / carregarProcesso — hashes por parte (S4)', () => {
  test('processo.json grava fixado e hashes = sha256(JCS) de cada parte', () => {
    prepararNucleoEUmSchema();
    const resultado = criarProcesso(dir, PROJETO, 'p1', () => new Date('2026-01-01T00:00:00.000Z'));
    const manifesto = lerManifesto('p1');

    expect(manifesto.hashes.schemas).toBe(sha256hex(canonicalize(manifesto.fixado.tipos) ?? ''));
    expect(manifesto.hashes.vocabulario).toBe(
      sha256hex(canonicalize(manifesto.fixado.vocabulario) ?? ''),
    );
    expect(manifesto.hashes.gates).toBe(sha256hex(canonicalize(manifesto.fixado.gates) ?? ''));
    expect(resultado.hashes).toEqual(manifesto.hashes);
  });

  test('hashes.schemas divergente do fixado → PROCESSO_CORROMPIDO com caminho /hashes/schemas', () => {
    prepararNucleoEUmSchema();
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    const arquivo = path.join(dir, PROJETO, 'p1', 'processo.json');
    const manifesto = lerManifesto('p1');
    manifesto.hashes.schemas = 'f'.repeat(64);
    fs.writeFileSync(arquivo, JSON.stringify(manifesto));

    const erro = capturarErro(() => carregarProcesso(dir, PROJETO, 'p1'));
    expect(erro.codigo).toBe('PROCESSO_CORROMPIDO');
    expect(erro.detalhes).toContainEqual(expect.objectContaining({ caminho: '/hashes/schemas' }));
  });
});

describe('criarProcesso / carregarProcesso (N14)', () => {
  test('ancora = sha256hex(canonicalize(processo.json lido do disco))', () => {
    prepararNucleoEUmSchema();
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    const manifesto = lerManifesto('p1');
    const carregado = carregarProcesso(dir, PROJETO, 'p1');
    expect(carregado.ancora).toBe(sha256hex(canonicalize(manifesto) ?? ''));
  });

  test('diretório de processo sem manifesto (crash simulado) → criarProcesso cria normalmente', () => {
    fs.mkdirSync(path.join(dir, PROJETO, 'p1'), { recursive: true, mode: 0o700 });
    prepararNucleoEUmSchema();

    expect(() => criarProcesso(dir, PROJETO, 'p1', () => new Date())).not.toThrow();
    expect(fs.existsSync(path.join(dir, PROJETO, 'p1', 'processo.json'))).toBe(true);
  });

  test('segunda criarProcesso no mesmo nome → PROCESSO_JA_EXISTE', () => {
    prepararNucleoEUmSchema();
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    const erro = capturarErro(() => criarProcesso(dir, PROJETO, 'p1', () => new Date()));
    expect(erro.codigo).toBe('PROCESSO_JA_EXISTE');
  });

  test('alterar fixado e recalcular hashes → carga ok, mas âncora muda', () => {
    prepararNucleoEUmSchema();
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    const arquivo = path.join(dir, PROJETO, 'p1', 'processo.json');
    const ancoraOriginal = carregarProcesso(dir, PROJETO, 'p1').ancora;

    const alterado = lerManifesto('p1');
    alterado.fixado.gates = { novo: { criterio: 'critério novo' } };
    alterado.hashes.gates = sha256hex(canonicalize(alterado.fixado.gates) ?? '');
    fs.writeFileSync(arquivo, JSON.stringify(alterado));

    const carregado = carregarProcesso(dir, PROJETO, 'p1');
    expect(carregado.ancora).not.toBe(ancoraOriginal);
  });
});

describe('vocabulário', () => {
  test('hash de fixado.vocabulario independe da ordem em que os donos foram registrados', () => {
    registrarVocabulario(dir, PROJETO, 'nucleo', { marcoTipo: [], resultado: [], acao: [] });
    registrarVocabulario(dir, PROJETO, 'dono-a', { marcoTipo: ['a'], resultado: [], acao: [] });
    registrarVocabulario(dir, PROJETO, 'dono-b', { marcoTipo: ['b'], resultado: [], acao: [] });
    const p1 = criarProcesso(dir, PROJETO, 'p1', () => new Date());

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definicoes-'));
    try {
      registrarVocabulario(dir2, PROJETO, 'nucleo', { marcoTipo: [], resultado: [], acao: [] });
      registrarVocabulario(dir2, PROJETO, 'dono-b', { marcoTipo: ['b'], resultado: [], acao: [] });
      registrarVocabulario(dir2, PROJETO, 'dono-a', { marcoTipo: ['a'], resultado: [], acao: [] });
      const p2 = criarProcesso(dir2, PROJETO, 'p1', () => new Date());

      expect(p2.hashes.vocabulario).toBe(p1.hashes.vocabulario);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('sem nenhum arquivo de vocabulário → VOCABULARIO_AUSENTE', () => {
    registrarTipo(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
    const erro = capturarErro(() => criarProcesso(dir, PROJETO, 'p1', () => new Date()));
    expect(erro.codigo).toBe('VOCABULARIO_AUSENTE');
  });

  test('dono "nucleo" vira fixado.vocabulario.nucleo; demais donos viram porDono', () => {
    registrarVocabulario(dir, PROJETO, 'nucleo', {
      marcoTipo: ['revisao'],
      resultado: [],
      acao: [],
    });
    registrarVocabulario(dir, PROJETO, 'squad-x', {
      marcoTipo: ['extra'],
      resultado: [],
      acao: [],
    });
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    const manifesto = lerManifesto('p1');

    expect(manifesto.fixado.vocabulario.nucleo).toEqual({
      marcoTipo: ['revisao'],
      resultado: [],
      acao: [],
    });
    expect(manifesto.fixado.vocabulario.porDono).toEqual({
      'squad-x': { marcoTipo: ['extra'], resultado: [], acao: [] },
    });
  });
});

describe('caminho', () => {
  test('resolve um caminho dentro do diretório de dados', () => {
    expect(caminho(dir, PROJETO)).toBe(path.join(dir, PROJETO));
  });

  test('lança ErroHexlog INTERNO ao tentar escapar do diretório com ".."', () => {
    const erro = capturarErro(() => caminho(dir, '..', 'fora'));
    expect(erro.codigo).toBe('INTERNO');
  });
});

describe('substituiu', () => {
  test('registrarTipo: false na primeira gravação, true na segunda', () => {
    expect(registrarTipo(dir, PROJETO, 'decisao', SCHEMA_VALIDO).substituiu).toBe(false);
    expect(registrarTipo(dir, PROJETO, 'decisao', SCHEMA_VALIDO).substituiu).toBe(true);
  });

  test('registrarGate: false na primeira gravação, true na segunda', () => {
    expect(registrarGate(dir, PROJETO, 'gate-x', 'critério').substituiu).toBe(false);
    expect(registrarGate(dir, PROJETO, 'gate-x', 'critério novo').substituiu).toBe(true);
  });

  test('registrarVocabulario: false na primeira gravação, true na segunda', () => {
    const vocab = { marcoTipo: [], resultado: [], acao: [] };
    expect(registrarVocabulario(dir, PROJETO, 'nucleo', vocab).substituiu).toBe(false);
    expect(registrarVocabulario(dir, PROJETO, 'nucleo', vocab).substituiu).toBe(true);
  });
});

describe('lerProjeto', () => {
  test('PROJETO_INEXISTENTE quando o diretório do projeto não existe', () => {
    const erro = capturarErro(() => lerProjeto(dir, 'inexistente'));
    expect(erro.codigo).toBe('PROJETO_INEXISTENTE');
  });

  test('ignora nomes reservados e diretórios de processo sem processo.json', () => {
    prepararNucleoEUmSchema();
    criarProcesso(dir, PROJETO, 'p1', () => new Date());
    fs.mkdirSync(path.join(dir, PROJETO, 'p2-sem-manifesto'), { recursive: true });

    const projeto = lerProjeto(dir, PROJETO);
    expect(projeto.processos.map((p) => p.nome)).toEqual(['p1']);
    expect(projeto.tipos.map((t) => t.nome)).toEqual(['decisao']);
    expect(projeto.vocabulario.map((v) => v.dono)).toEqual(['nucleo']);
  });
});
