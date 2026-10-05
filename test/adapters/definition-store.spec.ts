import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import * as path from 'node:path';
import { createDefinitionStore } from '../../src/adapters/fs/definition-store.ts';
import {
  dataRoot,
  definitionDir,
  definitionFile,
  VERSION_SUFFIX,
} from '../../src/adapters/fs/data-format.ts';
import type { Gate, RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { DefinitionKind } from '../../src/ports.ts';
import { types } from '../fixtures/domains/omc.ts';
import { captureError, createTempDir, expectNoLeak } from '../helpers.ts';
import { countFsyncs } from './fsync-spy.ts';

afterEach(() => {
  jest.restoreAllMocks();
});

const PROJECT = 'demo';
const plan: RecordType = types.plan;
const planV2: RecordType = { type: 'object', properties: { title: { type: 'string' } } };
const relation: RelationName = {
  name: 'approves',
  kind: 'supports',
  from: ['review'],
  to: ['plan'],
};
const gate: Gate = {
  name: 'plan-ready',
  questions: [{ kind: 'approved', of: { type: 'plan' }, by: { type: 'review' } }],
};

function setup() {
  const dataDir = createTempDir('definition-store');
  return { dataDir, store: createDefinitionStore({ dataDir }) };
}

/** Pasta de versões de um nome, como o layout de D-02 a define. */
const versionsDir = (dataDir: string, kind: DefinitionKind, name: string) =>
  definitionDir(dataDir, PROJECT, kind, name);

const FIRST_VERSION_FILE = `1.0${VERSION_SUFFIX}`;

describe('createDefinitionStore: escrita e leitura', () => {
  test('grava e lê de volta cada tipo de definição, no layout de D-02', () => {
    const { dataDir, store } = setup();

    expect(store.write(PROJECT, 'types', 'plan', '1.0', plan)).toBe(true);
    expect(store.write(PROJECT, 'relations', 'approves', '1.0', relation)).toBe(true);
    expect(store.write(PROJECT, 'gates', 'plan-ready', '1.0', gate)).toBe(true);

    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    expect(store.read(PROJECT, 'relations', 'approves', '1.0')).toEqual(relation);
    expect(store.read(PROJECT, 'gates', 'plan-ready', '1.0')).toEqual(gate);
    expect(fs.existsSync(definitionFile(dataDir, PROJECT, 'types', 'plan', '1.0'))).toBe(true);
  });

  test('a escrita não deixa temporário na pasta de versões', () => {
    const { dataDir, store } = setup();

    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(fs.readdirSync(versionsDir(dataDir, 'types', 'plan'))).toEqual([FIRST_VERSION_FILE]);
  });

  test('names lista só as pastas de nome, em ordem alfabética, por tipo de definição', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'review', '1.0', plan);
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    store.write(PROJECT, 'gates', 'plan-ready', '1.0', gate);
    fs.writeFileSync(path.join(dataRoot(dataDir), PROJECT, 'types', 'solto.json'), '{}');

    expect(store.names(PROJECT, 'types')).toEqual(['plan', 'review']);
    expect(store.names(PROJECT, 'gates')).toEqual(['plan-ready']);
    expect(store.names(PROJECT, 'relations')).toEqual([]);
    expect(store.names('outro', 'types')).toEqual([]);
  });

  test('names lista a pasta de nome que ficou sem nenhuma versão (falha no meio de write)', () => {
    const { dataDir, store } = setup();
    fs.mkdirSync(versionsDir(dataDir, 'types', 'empty'), { recursive: true });

    expect(store.names(PROJECT, 'types')).toEqual(['empty']);
    expect(store.versions(PROJECT, 'types', 'empty')).toEqual([]);
  });
});

describe('createDefinitionStore: ordem das versões', () => {
  test('versions ordena major e minor como números, não como texto', () => {
    const { store } = setup();
    for (const version of ['1.10', '1.2', '2.0', '1.0', '10.1', '1.9']) {
      store.write(PROJECT, 'types', 'plan', version, plan);
    }

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual([
      '1.0',
      '1.2',
      '1.9',
      '1.10',
      '2.0',
      '10.1',
    ]);
  });

  test('versions de um nome sem versão gravada é vazio', () => {
    const { store } = setup();

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual([]);
  });

  test('versions ignora temporário, arquivo fora do padrão e diretório', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    const dir = versionsDir(dataDir, 'types', 'plan');
    fs.writeFileSync(path.join(dir, '.1.1.json.123.abcd'), '{}');
    fs.writeFileSync(path.join(dir, '01.0.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    fs.mkdirSync(path.join(dir, '2.0.json'));

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual(['1.0']);
  });
});

describe('createDefinitionStore: imutabilidade', () => {
  test('a segunda escrita da mesma versão devolve false e preserva os bytes', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    const file = definitionFile(dataDir, PROJECT, 'types', 'plan', '1.0');
    const before = fs.readFileSync(file);

    expect(store.write(PROJECT, 'types', 'plan', '1.0', planV2)).toBe(false);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    expect(fs.readdirSync(versionsDir(dataDir, 'types', 'plan'))).toEqual([FIRST_VERSION_FILE]);
  });

  test('outra versão do mesmo nome grava sem tocar a anterior', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(store.write(PROJECT, 'types', 'plan', '1.1', planV2)).toBe(true);

    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    expect(store.read(PROJECT, 'types', 'plan', '1.1')).toEqual(planV2);
  });

  test('faz fsync do diretório só na escrita que publica; a repetida (EEXIST) não dá nenhum', () => {
    const { store } = setup();
    const fsyncs = countFsyncs();

    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    expect(fsyncs().directories).toBe(1);

    expect(store.write(PROJECT, 'types', 'plan', '1.0', planV2)).toBe(false);
    expect(fsyncs().directories).toBe(1);
  });

  test('corrida: o concorrente publica entre o temporário e o link, e só um escritor ganha', () => {
    const { dataDir, store } = setup();
    const rival = createDefinitionStore({ dataDir });
    const realLink = fs.linkSync.bind(fs);
    let rivalResult: boolean | undefined;
    jest.spyOn(fs, 'linkSync').mockImplementationOnce((existing, target) => {
      rivalResult = rival.write(PROJECT, 'types', 'plan', '1.0', planV2);
      realLink(existing, target);
    });

    const result = store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(rivalResult).toBe(true);
    expect(result).toBe(false);
    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(planV2);
    expect(fs.readdirSync(versionsDir(dataDir, 'types', 'plan'))).toEqual([FIRST_VERSION_FILE]);
  });
});

describe('createDefinitionStore: arquivo legado', () => {
  test('o arquivo legado <nome>.json é ignorado e nunca materializado', () => {
    const { dataDir, store } = setup();
    const legacyBytes = JSON.stringify({ type: 'object', legacy: true });
    const legacyFiles = [
      path.join(dataDir, PROJECT, 'schemas', 'plan.json'),
      path.join(dataRoot(dataDir), PROJECT, 'types', 'plan.json'),
    ];
    for (const file of legacyFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, legacyBytes);
    }

    expect(store.names(PROJECT, 'types')).toEqual([]);
    expect(store.versions(PROJECT, 'types', 'plan')).toEqual([]);
    expect(captureError(() => store.read(PROJECT, 'types', 'plan', '1.0')).code).toBe(
      'TYPE_NOT_FOUND',
    );
    expect(store.write(PROJECT, 'types', 'plan', '1.0', plan)).toBe(true);

    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    for (const file of legacyFiles) expect(fs.readFileSync(file, 'utf8')).toBe(legacyBytes);
  });
});

describe('createDefinitionStore: erros', () => {
  test.each([
    ['types', 'TYPE_NOT_FOUND'],
    ['relations', 'RELATION_NOT_FOUND'],
    ['gates', 'GATE_NOT_FOUND'],
  ] as const)(
    'read de nome que nunca existiu em %s lança %s com unknown-name, sem caminho absoluto',
    (kind, code) => {
      const { dataDir, store } = setup();

      const error = captureError(() => store.read(PROJECT, kind, 'missing', '1.0'));

      expect(error.code).toBe(code);
      expect(error.details).toEqual([
        { path: '/name', code: 'unknown-name', message: 'definition name not found' },
      ]);
      expectNoLeak(error, dataDir);
    },
  );

  test.each([
    ['types', 'TYPE_NOT_FOUND', plan],
    ['relations', 'RELATION_NOT_FOUND', relation],
    ['gates', 'GATE_NOT_FOUND', gate],
  ] as const)(
    'read de versão ausente em %s lança %s com unknown-version e as versões existentes, em ordem numérica',
    (kind, code, definition) => {
      const { dataDir, store } = setup();
      for (const version of ['1.10', '1.0', '1.2']) {
        store.write(PROJECT, kind, 'known', version, definition);
      }

      const error = captureError(() => store.read(PROJECT, kind, 'known', '2.0'));

      expect(error.code).toBe(code);
      expect(error.details).toEqual([
        {
          path: '/version',
          code: 'unknown-version',
          message: 'definition version not found',
          versions: ['1.0', '1.2', '1.10'],
        },
      ]);
      expectNoLeak(error, dataDir);
    },
  );

  test('pasta do nome sem nenhuma versão é unknown-name, sem lista de versões', () => {
    const { dataDir, store } = setup();
    fs.mkdirSync(versionsDir(dataDir, 'types', 'empty'), { recursive: true });

    expect(captureError(() => store.read(PROJECT, 'types', 'empty', '1.0')).details).toEqual([
      { path: '/name', code: 'unknown-name', message: 'definition name not found' },
    ]);
  });

  test.each([
    '',
    '1',
    '1.',
    '1.0.0',
    '01.0',
    '1.07',
    '1234567.0',
    '1.-1',
    '../1.0',
    '1.0/../../x',
    'a.b',
  ])('versão malformada %j é recusada antes de qualquer I/O', (version) => {
    const { dataDir, store } = setup();

    expect(captureError(() => store.write(PROJECT, 'types', 'plan', version, plan)).code).toBe(
      'INVALID_INPUT',
    );
    expect(captureError(() => store.read(PROJECT, 'types', 'plan', version)).code).toBe(
      'INVALID_INPUT',
    );
    expect(fs.existsSync(dataRoot(dataDir))).toBe(false);
  });

  test.each(['..', 'a/b', 'A', '', '.hidden'])(
    'nome ou projeto %j que escapa do layout é recusado',
    (name) => {
      const { dataDir, store } = setup();

      expect(captureError(() => store.write(name, 'types', 'plan', '1.0', plan)).code).toBe(
        'INVALID_INPUT',
      );
      expect(captureError(() => store.write(PROJECT, 'types', name, '1.0', plan)).code).toBe(
        'INVALID_INPUT',
      );
      expect(captureError(() => store.versions(PROJECT, 'types', name)).code).toBe('INVALID_INPUT');
      expect(captureError(() => store.names(name, 'types')).code).toBe('INVALID_INPUT');
      expect(fs.existsSync(dataRoot(dataDir))).toBe(false);
    },
  );

  test.each([
    ['JSON inválido', '{nope'],
    ['definição fora do schema', JSON.stringify({ name: 'x', kind: 'not-a-kind' })],
  ])('arquivo de versão com %s lança INTERNAL sem o conteúdo', (_, content) => {
    const { dataDir, store } = setup();
    const dir = versionsDir(dataDir, 'relations', 'approves');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FIRST_VERSION_FILE), content);

    const error = captureError(() => store.read(PROJECT, 'relations', 'approves', '1.0'));

    expect(error.code).toBe('INTERNAL');
    expect(error.details[0]?.code).toBe('unreadable-definition');
    expectNoLeak(error, dataDir);
  });

  test.each([
    ['types', 'big-type', { type: 'object', description: 'x'.repeat(17_000) }],
    ['relations', 'approves', { ...relation, kind: 'not-a-kind' }],
    ['gates', 'plan-ready', { ...gate, questions: [] }],
  ] as const)(
    'write de definição que o schema recusa (%s) lança INTERNAL e não grava nada',
    (kind, name, invalid) => {
      const { dataDir, store } = setup();

      const error = captureError(() => store.write(PROJECT, kind, name, '1.0', invalid as never));

      expect(error.code).toBe('INTERNAL');
      expect(error.details).toEqual([
        {
          path: '/definition',
          code: 'invalid-definition',
          message: 'definition does not match its schema',
        },
      ]);
      expectNoLeak(error, 'x'.repeat(100));
      expect(store.versions(PROJECT, kind, name)).toEqual([]);
      expect(fs.existsSync(definitionFile(dataDir, PROJECT, kind, name, '1.0'))).toBe(false);
    },
  );

  test('erro do fs vira IO_ERROR só com o errno em minúsculas, sem o caminho', () => {
    const { dataDir, store } = setup();
    // Um arquivo no lugar da pasta do projeto: o `mkdir` da escrita falha com ENOTDIR.
    fs.mkdirSync(dataRoot(dataDir), { recursive: true });
    fs.writeFileSync(path.join(dataRoot(dataDir), PROJECT), 'not a directory');

    const error = captureError(() => store.write(PROJECT, 'types', 'plan', '1.0', plan));

    expect(error.code).toBe('IO_ERROR');
    expect(error.details).toEqual([{ path: '', code: 'enotdir', message: 'I/O failure' }]);
    expectNoLeak(error, dataDir);
  });
});
