import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { sha256hex } from '../src/chain.ts';
import { resolveSafePath } from '../src/storage.ts';
import type { ProcessManifest } from '../src/definitions.ts';
import {
  loadProcess,
  createProcess,
  readProject,
  registerGate,
  registerType,
  registerVocabulary,
  RESERVED_PROCESS_NAMES,
  bumpVersion,
  compareVersions,
  formatVersion,
  listVersionFiles,
  listVersions,
  parseVersion,
  resolveCurrentDefinition,
} from '../src/definitions.ts';
import { HexlogError } from '../src/errors.ts';
import { parseJson } from './helpers.ts';

const PROJECT = 'test-project';
const VALID_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

// Forma de schemas/<name>.json gravado por `registerType` (S1).
const RegisteredTypeSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  hash: z.string(),
  registeredAt: z.string(),
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definitions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Executa `fn`, afirma que lançou `HexlogError` e devolve o erro para asserções específicas. */
function captureError(fn: () => unknown): HexlogError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HexlogError);
    return error as HexlogError;
  }
  throw new Error('expected the function to throw HexlogError');
}

/** Registra um núcleo de vocabulário mínimo e um schema custom, pré-requisito de `createProcess`. */
function prepareCoreAndType(): void {
  registerVocabulary(dir, PROJECT, 'core', { milestoneType: ['review'], result: [], action: [] });
  registerType(dir, PROJECT, 'decision', VALID_SCHEMA);
}

function readManifest(process: string): ProcessManifest {
  return JSON.parse(
    fs.readFileSync(path.join(dir, PROJECT, process, 'process.json'), 'utf8'),
  ) as ProcessManifest;
}

describe('registerType (S1)', () => {
  test('grava schemas/<nome>.json com nome, schema, hash e registeredAt', () => {
    const result = registerType(dir, PROJECT, 'decision', VALID_SCHEMA);
    const written = parseJson(
      RegisteredTypeSchema,
      fs.readFileSync(resolveSafePath(dir, PROJECT, 'schemas', 'decision.json'), 'utf8'),
    );
    expect(written).toEqual({
      name: 'decision',
      schema: VALID_SCHEMA,
      hash: result.hash,
      registeredAt: expect.any(String),
    });
  });

  test('rejeita $ref externo, sem gravar arquivo', () => {
    const error = captureError(() =>
      registerType(dir, PROJECT, 'with-ref', { $ref: 'http://x/y' }),
    );
    expect(error.code).toBe('INVALID_SCHEMA');
    expect(fs.existsSync(resolveSafePath(dir, PROJECT, 'schemas', 'with-ref.json'))).toBe(false);
  });

  test.each(['milestone', 'verdict'])('rejeita nome reservado "%s", sem gravar arquivo', (name) => {
    const error = captureError(() => registerType(dir, PROJECT, name, VALID_SCHEMA));
    expect(error.code).toBe('RESERVED_NAME');
    expect(fs.existsSync(resolveSafePath(dir, PROJECT, 'schemas', `${name}.json`))).toBe(false);
  });
});

describe('registerType — INVALID_SCHEMA sem gravar arquivo (S7)', () => {
  const CASES: [string, Record<string, unknown>][] = [
    ['keyword with typo ("typ")', { type: 'object', typ: 'object' }],
    ['malformed required (string instead of array)', { type: 'object', required: 'a' }],
    ['root is not "type": "object"', { type: 'string' }],
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

  test.each(CASES)('%s → INVALID_SCHEMA', (_description, schema) => {
    const error = captureError(() => registerType(dir, PROJECT, 'invalid-type', schema));
    expect(error.code).toBe('INVALID_SCHEMA');
    expect(fs.existsSync(resolveSafePath(dir, PROJECT, 'schemas', 'invalid-type.json'))).toBe(
      false,
    );
  });

  test('schema com mais de 16 000 caracteres canônicos → INVALID_SCHEMA com detalhe too_big', () => {
    const giantSchema = {
      type: 'object',
      properties: { text: { type: 'string', description: 'x'.repeat(16_500) } },
    };
    const error = captureError(() => registerType(dir, PROJECT, 'giant-type', giantSchema));
    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.details).toContainEqual(expect.objectContaining({ code: 'too_big' }));
    expect(fs.existsSync(resolveSafePath(dir, PROJECT, 'schemas', 'giant-type.json'))).toBe(false);
  });
});

describe('createProcess / registerGate — nomes reservados (S8)', () => {
  test.each(RESERVED_PROCESS_NAMES)(
    'createProcess com processo="%s" → RESERVED_NAME',
    (process) => {
      const error = captureError(() => createProcess(dir, PROJECT, process, () => new Date()));
      expect(error.code).toBe('RESERVED_NAME');
    },
  );

  test('registerGate com nome de gate embutido (no-orphans) → RESERVED_NAME', () => {
    const error = captureError(() => registerGate(dir, PROJECT, 'no-orphans', 'any criteria'));
    expect(error.code).toBe('RESERVED_NAME');
  });
});

describe('createProcess / loadProcess — hashes por parte (S4)', () => {
  test('process.json grava fixado e hashes = sha256(JCS) de cada parte', () => {
    prepareCoreAndType();
    const result = createProcess(dir, PROJECT, 'p1', () => new Date('2026-01-01T00:00:00.000Z'));
    const manifest = readManifest('p1');

    expect(manifest.hashes.schemas).toBe(sha256hex(canonicalize(manifest.fixed.types) ?? ''));
    expect(manifest.hashes.vocabulary).toBe(
      sha256hex(canonicalize(manifest.fixed.vocabulary) ?? ''),
    );
    expect(manifest.hashes.gates).toBe(sha256hex(canonicalize(manifest.fixed.gates) ?? ''));
    expect(result.hashes).toEqual(manifest.hashes);
  });

  test('hashes.schemas divergente do fixado → PROCESS_CORRUPTED com caminho /hashes/schemas', () => {
    prepareCoreAndType();
    createProcess(dir, PROJECT, 'p1', () => new Date());
    const file = path.join(dir, PROJECT, 'p1', 'process.json');
    const manifest = readManifest('p1');
    manifest.hashes.schemas = 'f'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest));

    const error = captureError(() => loadProcess(dir, PROJECT, 'p1'));
    expect(error.code).toBe('PROCESS_CORRUPTED');
    expect(error.details).toContainEqual(expect.objectContaining({ path: '/hashes/schemas' }));
  });
});

describe('createProcess / loadProcess (N14)', () => {
  test('ancora = sha256hex(canonicalize(process.json lido do disco))', () => {
    prepareCoreAndType();
    createProcess(dir, PROJECT, 'p1', () => new Date());
    const manifest = readManifest('p1');
    const loaded = loadProcess(dir, PROJECT, 'p1');
    expect(loaded.anchor).toBe(sha256hex(canonicalize(manifest) ?? ''));
  });

  test('diretório de processo sem manifesto (crash simulado) → createProcess cria normalmente', () => {
    fs.mkdirSync(path.join(dir, PROJECT, 'p1'), { recursive: true, mode: 0o700 });
    prepareCoreAndType();

    expect(() => createProcess(dir, PROJECT, 'p1', () => new Date())).not.toThrow();
    expect(fs.existsSync(path.join(dir, PROJECT, 'p1', 'process.json'))).toBe(true);
  });

  test('segunda createProcess no mesmo nome → PROCESS_ALREADY_EXISTS', () => {
    prepareCoreAndType();
    createProcess(dir, PROJECT, 'p1', () => new Date());
    const error = captureError(() => createProcess(dir, PROJECT, 'p1', () => new Date()));
    expect(error.code).toBe('PROCESS_ALREADY_EXISTS');
  });

  test('alterar fixado e recalcular hashes → carga ok, mas âncora muda', () => {
    prepareCoreAndType();
    createProcess(dir, PROJECT, 'p1', () => new Date());
    const file = path.join(dir, PROJECT, 'p1', 'process.json');
    const originalAnchor = loadProcess(dir, PROJECT, 'p1').anchor;

    const changed = readManifest('p1');
    changed.fixed.gates = { 'new-gate': { criteria: 'new criteria' } };
    changed.hashes.gates = sha256hex(canonicalize(changed.fixed.gates) ?? '');
    fs.writeFileSync(file, JSON.stringify(changed));

    const loaded = loadProcess(dir, PROJECT, 'p1');
    expect(loaded.anchor).not.toBe(originalAnchor);
  });
});

describe('vocabulário', () => {
  test('hash de fixado.vocabulary independe da ordem em que os donos foram registrados', () => {
    registerVocabulary(dir, PROJECT, 'core', { milestoneType: [], result: [], action: [] });
    registerVocabulary(dir, PROJECT, 'owner-a', { milestoneType: ['a'], result: [], action: [] });
    registerVocabulary(dir, PROJECT, 'owner-b', { milestoneType: ['b'], result: [], action: [] });
    const p1 = createProcess(dir, PROJECT, 'p1', () => new Date());

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlog-definitions-'));
    try {
      registerVocabulary(dir2, PROJECT, 'core', { milestoneType: [], result: [], action: [] });
      registerVocabulary(dir2, PROJECT, 'owner-b', {
        milestoneType: ['b'],
        result: [],
        action: [],
      });
      registerVocabulary(dir2, PROJECT, 'owner-a', {
        milestoneType: ['a'],
        result: [],
        action: [],
      });
      const p2 = createProcess(dir2, PROJECT, 'p1', () => new Date());

      expect(p2.hashes.vocabulary).toBe(p1.hashes.vocabulary);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('sem nenhum arquivo de vocabulário → VOCABULARY_MISSING', () => {
    registerType(dir, PROJECT, 'decision', VALID_SCHEMA);
    const error = captureError(() => createProcess(dir, PROJECT, 'p1', () => new Date()));
    expect(error.code).toBe('VOCABULARY_MISSING');
  });

  test('dono "core" vira fixed.vocabulary.core; demais donos viram byOwner', () => {
    registerVocabulary(dir, PROJECT, 'core', {
      milestoneType: ['review'],
      result: [],
      action: [],
    });
    registerVocabulary(dir, PROJECT, 'squad-x', {
      milestoneType: ['extra'],
      result: [],
      action: [],
    });
    createProcess(dir, PROJECT, 'p1', () => new Date());
    const manifest = readManifest('p1');

    expect(manifest.fixed.vocabulary.core).toEqual({
      milestoneType: ['review'],
      result: [],
      action: [],
    });
    expect(manifest.fixed.vocabulary.byOwner).toEqual({
      'squad-x': { milestoneType: ['extra'], result: [], action: [] },
    });
  });
});

describe('caminho', () => {
  test('resolve um caminho dentro do diretório de dados', () => {
    expect(resolveSafePath(dir, PROJECT)).toBe(path.join(dir, PROJECT));
  });

  test('lança HexlogError INTERNAL ao tentar escapar do diretório com ".."', () => {
    const error = captureError(() => resolveSafePath(dir, '..', 'outside'));
    expect(error.code).toBe('INTERNAL');
  });
});

describe('substituiu', () => {
  test('registerType: false na primeira gravação, true na segunda', () => {
    expect(registerType(dir, PROJECT, 'decision', VALID_SCHEMA).replaced).toBe(false);
    expect(registerType(dir, PROJECT, 'decision', VALID_SCHEMA).replaced).toBe(true);
  });

  test('registerGate: false na primeira gravação, true na segunda', () => {
    expect(registerGate(dir, PROJECT, 'gate-x', 'criteria').replaced).toBe(false);
    expect(registerGate(dir, PROJECT, 'gate-x', 'new criteria').replaced).toBe(true);
  });

  test('registerVocabulary: false na primeira gravação, true na segunda', () => {
    const vocab = { milestoneType: [], result: [], action: [] };
    expect(registerVocabulary(dir, PROJECT, 'core', vocab).replaced).toBe(false);
    expect(registerVocabulary(dir, PROJECT, 'core', vocab).replaced).toBe(true);
  });
});

describe('readProject', () => {
  test('PROJECT_NOT_FOUND quando o diretório do projeto não existe', () => {
    const error = captureError(() => readProject(dir, 'nonexistent'));
    expect(error.code).toBe('PROJECT_NOT_FOUND');
  });

  test('ignora nomes reservados e diretórios de processo sem process.json', () => {
    prepareCoreAndType();
    createProcess(dir, PROJECT, 'p1', () => new Date());
    fs.mkdirSync(path.join(dir, PROJECT, 'p2-without-manifest'), { recursive: true });

    const project = readProject(dir, PROJECT);
    expect(project.processes.map((p) => p.name)).toEqual(['p1']);
    expect(project.types.map((t) => t.name)).toEqual(['decision']);
    expect(project.vocabulary.map((v) => v.owner)).toEqual(['core']);
  });
});

describe('versionamento de definições (Leva 1)', () => {
  test('compareVersions compara numericamente: 1.10 é maior que 1.9 (critério 13)', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '1.10')).toBeLessThan(0);
    expect(compareVersions('1.2', '1.2')).toBe(0);
  });

  test('parseVersion, formatVersion e bumpVersion', () => {
    expect(parseVersion('2.7')).toEqual({ major: 2, minor: 7 });
    expect(formatVersion({ major: 2, minor: 7 })).toBe('2.7');
    expect(bumpVersion('2.7', 'minor')).toEqual({ major: 2, minor: 8 });
    expect(bumpVersion('2.7', 'major')).toEqual({ major: 3, minor: 0 });
  });

  test('listVersionFiles ordena 1.9 antes de 1.10 e ignora nomes fora de major.minor.json (P4)', () => {
    const defDir = path.join(dir, PROJECT, 'schemas', 'decision');
    fs.mkdirSync(defDir, { recursive: true });
    for (const name of ['1.9.json', '1.10.json', 'notes.json', '1.0.0.json', 'v2.json']) {
      fs.writeFileSync(path.join(defDir, name), '{}');
    }

    expect(listVersionFiles(defDir)).toEqual(['1.9', '1.10']);
  });

  describe('resolveCurrentDefinition', () => {
    const partDir = () => path.join(dir, PROJECT, 'schemas');

    test('diretório com versões: o vigente é a maior delas', () => {
      const defDir = path.join(partDir(), 'decision');
      fs.mkdirSync(defDir, { recursive: true });
      fs.writeFileSync(path.join(defDir, '1.1.json'), JSON.stringify({ v: 'a' }));
      fs.writeFileSync(path.join(defDir, '1.2.json'), JSON.stringify({ v: 'b' }));

      expect(resolveCurrentDefinition(partDir(), 'decision')).toEqual({
        version: '1.2',
        content: { v: 'b' },
      });
    });

    test('sem diretório, só legado: o vigente é o legado como "1.0"', () => {
      fs.mkdirSync(partDir(), { recursive: true });
      fs.writeFileSync(path.join(partDir(), 'decision.json'), JSON.stringify({ v: 'legacy' }));

      expect(resolveCurrentDefinition(partDir(), 'decision')).toEqual({
        version: '1.0',
        content: { v: 'legacy' },
      });
    });

    test('diretório existente mas vazio cai no ramo do legado', () => {
      const defDir = path.join(partDir(), 'decision');
      fs.mkdirSync(defDir, { recursive: true });
      fs.writeFileSync(path.join(partDir(), 'decision.json'), JSON.stringify({ v: 'legacy' }));

      expect(resolveCurrentDefinition(partDir(), 'decision')).toEqual({
        version: '1.0',
        content: { v: 'legacy' },
      });
    });

    test('nem diretório nem legado: null', () => {
      fs.mkdirSync(partDir(), { recursive: true });
      expect(resolveCurrentDefinition(partDir(), 'nonexistent')).toBeNull();
    });
  });

  test('listVersions une legado ("1.0") com as versões do diretório, sem duplicata (D2)', () => {
    const partDir = path.join(dir, PROJECT, 'schemas');
    const defDir = path.join(partDir, 'decision');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, 'decision.json'), JSON.stringify({ v: 'legacy' }));
    fs.writeFileSync(path.join(defDir, '1.1.json'), JSON.stringify({ v: 'a' }));

    expect(listVersions(partDir, 'decision')).toEqual(['1.0', '1.1']);
  });
});
