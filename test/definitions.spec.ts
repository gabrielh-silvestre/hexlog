import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { sha256hex } from '../src/chain.ts';
import { resolveSafePath, RESERVED_PROCESS_NAMES } from '../src/storage.ts';
import type { ProcessManifest } from '../src/definitions.ts';
import {
  loadProcess,
  createProcess,
  readProject,
  registerGate,
  registerType,
  registerVocabulary,
} from '../src/definitions.ts';
import { HexlogError } from '../src/errors.ts';
import { parseJson } from './helpers.ts';

const PROJETO = 'projeto-teste';
const SCHEMA_VALIDO = {
  type: 'object',
  properties: { texto: { type: 'string' } },
  required: ['texto'],
  additionalProperties: false,
};

// Forma de schemas/<name>.json gravado por `registerType` (S1).
const RegistroTipoSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  hash: z.string(),
  registeredAt: z.string(),
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definicoes-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Executa `fn`, afirma que lançou `HexlogError` e devolve o erro para asserções específicas. */
function capturarErro(fn: () => unknown): HexlogError {
  try {
    fn();
  } catch (erro) {
    expect(erro).toBeInstanceOf(HexlogError);
    return erro as HexlogError;
  }
  throw new Error('esperava que a função lançasse HexlogError');
}

/** Registra um núcleo de vocabulário mínimo e um schema custom, pré-requisito de `createProcess`. */
function prepararNucleoEUmSchema(): void {
  registerVocabulary(dir, PROJETO, 'core', { milestoneType: ['revisao'], result: [], action: [] });
  registerType(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
}

function lerManifesto(processo: string): ProcessManifest {
  return JSON.parse(
    fs.readFileSync(path.join(dir, PROJETO, processo, 'process.json'), 'utf8'),
  ) as ProcessManifest;
}

describe('registrarTipo (S1)', () => {
  test('grava schemas/<nome>.json com nome, schema, hash e registradoEm', () => {
    const resultado = registerType(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
    const gravado = parseJson(
      RegistroTipoSchema,
      fs.readFileSync(resolveSafePath(dir, PROJETO, 'schemas', 'decisao.json'), 'utf8'),
    );
    expect(gravado).toEqual({
      name: 'decisao',
      schema: SCHEMA_VALIDO,
      hash: resultado.hash,
      registeredAt: expect.any(String),
    });
  });

  test('rejeita $ref externo, sem gravar arquivo', () => {
    const erro = capturarErro(() => registerType(dir, PROJETO, 'com-ref', { $ref: 'http://x/y' }));
    expect(erro.code).toBe('INVALID_SCHEMA');
    expect(fs.existsSync(resolveSafePath(dir, PROJETO, 'schemas', 'com-ref.json'))).toBe(false);
  });

  test.each(['milestone', 'verdict'])('rejeita nome reservado "%s", sem gravar arquivo', (nome) => {
    const erro = capturarErro(() => registerType(dir, PROJETO, nome, SCHEMA_VALIDO));
    expect(erro.code).toBe('RESERVED_NAME');
    expect(fs.existsSync(resolveSafePath(dir, PROJETO, 'schemas', `${nome}.json`))).toBe(false);
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
    const erro = capturarErro(() => registerType(dir, PROJETO, 'tipo-invalido', schema));
    expect(erro.code).toBe('INVALID_SCHEMA');
    expect(fs.existsSync(resolveSafePath(dir, PROJETO, 'schemas', 'tipo-invalido.json'))).toBe(
      false,
    );
  });

  test('schema com mais de 16 000 caracteres canônicos → SCHEMA_INVALIDO com detalhe too_big', () => {
    const schemaGigante = {
      type: 'object',
      properties: { texto: { type: 'string', description: 'x'.repeat(16_500) } },
    };
    const erro = capturarErro(() => registerType(dir, PROJETO, 'tipo-gigante', schemaGigante));
    expect(erro.code).toBe('INVALID_SCHEMA');
    expect(erro.details).toContainEqual(expect.objectContaining({ code: 'too_big' }));
    expect(fs.existsSync(resolveSafePath(dir, PROJETO, 'schemas', 'tipo-gigante.json'))).toBe(
      false,
    );
  });
});

describe('criarProcesso / registrarGate — nomes reservados (S8)', () => {
  test.each(RESERVED_PROCESS_NAMES)(
    'criarProcesso com processo="%s" → NOME_RESERVADO',
    (processo) => {
      const erro = capturarErro(() => createProcess(dir, PROJETO, processo, () => new Date()));
      expect(erro.code).toBe('RESERVED_NAME');
    },
  );

  test('registrarGate com nome de gate embutido (no-orphans) → NOME_RESERVADO', () => {
    const erro = capturarErro(() => registerGate(dir, PROJETO, 'no-orphans', 'critério qualquer'));
    expect(erro.code).toBe('RESERVED_NAME');
  });
});

describe('criarProcesso / carregarProcesso — hashes por parte (S4)', () => {
  test('process.json grava fixado e hashes = sha256(JCS) de cada parte', () => {
    prepararNucleoEUmSchema();
    const resultado = createProcess(dir, PROJETO, 'p1', () => new Date('2026-01-01T00:00:00.000Z'));
    const manifesto = lerManifesto('p1');

    expect(manifesto.hashes.schemas).toBe(sha256hex(canonicalize(manifesto.fixed.types) ?? ''));
    expect(manifesto.hashes.vocabulary).toBe(
      sha256hex(canonicalize(manifesto.fixed.vocabulary) ?? ''),
    );
    expect(manifesto.hashes.gates).toBe(sha256hex(canonicalize(manifesto.fixed.gates) ?? ''));
    expect(resultado.hashes).toEqual(manifesto.hashes);
  });

  test('hashes.schemas divergente do fixado → PROCESSO_CORROMPIDO com caminho /hashes/schemas', () => {
    prepararNucleoEUmSchema();
    createProcess(dir, PROJETO, 'p1', () => new Date());
    const arquivo = path.join(dir, PROJETO, 'p1', 'process.json');
    const manifesto = lerManifesto('p1');
    manifesto.hashes.schemas = 'f'.repeat(64);
    fs.writeFileSync(arquivo, JSON.stringify(manifesto));

    const erro = capturarErro(() => loadProcess(dir, PROJETO, 'p1'));
    expect(erro.code).toBe('PROCESS_CORRUPTED');
    expect(erro.details).toContainEqual(expect.objectContaining({ path: '/hashes/schemas' }));
  });
});

describe('criarProcesso / carregarProcesso (N14)', () => {
  test('ancora = sha256hex(canonicalize(process.json lido do disco))', () => {
    prepararNucleoEUmSchema();
    createProcess(dir, PROJETO, 'p1', () => new Date());
    const manifesto = lerManifesto('p1');
    const carregado = loadProcess(dir, PROJETO, 'p1');
    expect(carregado.anchor).toBe(sha256hex(canonicalize(manifesto) ?? ''));
  });

  test('diretório de processo sem manifesto (crash simulado) → criarProcesso cria normalmente', () => {
    fs.mkdirSync(path.join(dir, PROJETO, 'p1'), { recursive: true, mode: 0o700 });
    prepararNucleoEUmSchema();

    expect(() => createProcess(dir, PROJETO, 'p1', () => new Date())).not.toThrow();
    expect(fs.existsSync(path.join(dir, PROJETO, 'p1', 'process.json'))).toBe(true);
  });

  test('segunda criarProcesso no mesmo nome → PROCESSO_JA_EXISTE', () => {
    prepararNucleoEUmSchema();
    createProcess(dir, PROJETO, 'p1', () => new Date());
    const erro = capturarErro(() => createProcess(dir, PROJETO, 'p1', () => new Date()));
    expect(erro.code).toBe('PROCESS_ALREADY_EXISTS');
  });

  test('alterar fixado e recalcular hashes → carga ok, mas âncora muda', () => {
    prepararNucleoEUmSchema();
    createProcess(dir, PROJETO, 'p1', () => new Date());
    const arquivo = path.join(dir, PROJETO, 'p1', 'process.json');
    const ancoraOriginal = loadProcess(dir, PROJETO, 'p1').anchor;

    const alterado = lerManifesto('p1');
    alterado.fixed.gates = { novo: { criteria: 'critério novo' } };
    alterado.hashes.gates = sha256hex(canonicalize(alterado.fixed.gates) ?? '');
    fs.writeFileSync(arquivo, JSON.stringify(alterado));

    const carregado = loadProcess(dir, PROJETO, 'p1');
    expect(carregado.anchor).not.toBe(ancoraOriginal);
  });
});

describe('vocabulário', () => {
  test('hash de fixado.vocabulary independe da ordem em que os donos foram registrados', () => {
    registerVocabulary(dir, PROJETO, 'core', { milestoneType: [], result: [], action: [] });
    registerVocabulary(dir, PROJETO, 'dono-a', { milestoneType: ['a'], result: [], action: [] });
    registerVocabulary(dir, PROJETO, 'dono-b', { milestoneType: ['b'], result: [], action: [] });
    const p1 = createProcess(dir, PROJETO, 'p1', () => new Date());

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definicoes-'));
    try {
      registerVocabulary(dir2, PROJETO, 'core', { milestoneType: [], result: [], action: [] });
      registerVocabulary(dir2, PROJETO, 'dono-b', { milestoneType: ['b'], result: [], action: [] });
      registerVocabulary(dir2, PROJETO, 'dono-a', { milestoneType: ['a'], result: [], action: [] });
      const p2 = createProcess(dir2, PROJETO, 'p1', () => new Date());

      expect(p2.hashes.vocabulary).toBe(p1.hashes.vocabulary);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('sem nenhum arquivo de vocabulário → VOCABULARIO_AUSENTE', () => {
    registerType(dir, PROJETO, 'decisao', SCHEMA_VALIDO);
    const erro = capturarErro(() => createProcess(dir, PROJETO, 'p1', () => new Date()));
    expect(erro.code).toBe('VOCABULARY_MISSING');
  });

  test('dono "nucleo" vira fixado.vocabulary.nucleo; demais donos viram porDono', () => {
    registerVocabulary(dir, PROJETO, 'core', {
      milestoneType: ['revisao'],
      result: [],
      action: [],
    });
    registerVocabulary(dir, PROJETO, 'squad-x', {
      milestoneType: ['extra'],
      result: [],
      action: [],
    });
    createProcess(dir, PROJETO, 'p1', () => new Date());
    const manifesto = lerManifesto('p1');

    expect(manifesto.fixed.vocabulary.core).toEqual({
      milestoneType: ['revisao'],
      result: [],
      action: [],
    });
    expect(manifesto.fixed.vocabulary.byOwner).toEqual({
      'squad-x': { milestoneType: ['extra'], result: [], action: [] },
    });
  });
});

describe('caminho', () => {
  test('resolve um caminho dentro do diretório de dados', () => {
    expect(resolveSafePath(dir, PROJETO)).toBe(path.join(dir, PROJETO));
  });

  test('lança ErroHexlog INTERNO ao tentar escapar do diretório com ".."', () => {
    const erro = capturarErro(() => resolveSafePath(dir, '..', 'fora'));
    expect(erro.code).toBe('INTERNAL');
  });
});

describe('substituiu', () => {
  test('registrarTipo: false na primeira gravação, true na segunda', () => {
    expect(registerType(dir, PROJETO, 'decisao', SCHEMA_VALIDO).replaced).toBe(false);
    expect(registerType(dir, PROJETO, 'decisao', SCHEMA_VALIDO).replaced).toBe(true);
  });

  test('registrarGate: false na primeira gravação, true na segunda', () => {
    expect(registerGate(dir, PROJETO, 'gate-x', 'critério').replaced).toBe(false);
    expect(registerGate(dir, PROJETO, 'gate-x', 'critério novo').replaced).toBe(true);
  });

  test('registrarVocabulario: false na primeira gravação, true na segunda', () => {
    const vocab = { milestoneType: [], result: [], action: [] };
    expect(registerVocabulary(dir, PROJETO, 'core', vocab).replaced).toBe(false);
    expect(registerVocabulary(dir, PROJETO, 'core', vocab).replaced).toBe(true);
  });
});

describe('lerProjeto', () => {
  test('PROJETO_INEXISTENTE quando o diretório do projeto não existe', () => {
    const erro = capturarErro(() => readProject(dir, 'inexistente'));
    expect(erro.code).toBe('PROJECT_NOT_FOUND');
  });

  test('ignora nomes reservados e diretórios de processo sem process.json', () => {
    prepararNucleoEUmSchema();
    createProcess(dir, PROJETO, 'p1', () => new Date());
    fs.mkdirSync(path.join(dir, PROJETO, 'p2-sem-manifesto'), { recursive: true });

    const projeto = readProject(dir, PROJETO);
    expect(projeto.processes.map((p) => p.name)).toEqual(['p1']);
    expect(projeto.types.map((t) => t.name)).toEqual(['decisao']);
    expect(projeto.vocabulary.map((v) => v.owner)).toEqual(['core']);
  });
});
