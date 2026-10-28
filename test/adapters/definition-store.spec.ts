import { afterEach, describe, expect, it, jest } from '@jest/globals';
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

/** Pasta de versões de um nome, como o layout do armazenamento de definições a define. */
const versionsDir = (dataDir: string, kind: DefinitionKind, name: string) =>
  definitionDir(dataDir, PROJECT, kind, name);

const FIRST_VERSION_FILE = `1.0${VERSION_SUFFIX}`;

const LEGACY_BYTES = JSON.stringify({ type: 'object', legacy: true });

/** Planta o arquivo legado `<nome>.json` nos dois lugares em que o formato antigo o deixava. */
function plantLegacyFiles(dataDir: string): string[] {
  const legacyFiles = [
    path.join(dataDir, PROJECT, 'schemas', 'plan.json'),
    path.join(dataRoot(dataDir), PROJECT, 'types', 'plan.json'),
  ];
  for (const file of legacyFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, LEGACY_BYTES);
  }
  return legacyFiles;
}

/** Pasta de nome sem nenhuma versão, como uma escrita que falhou a deixa. */
function plantEmptyNameFolder(dataDir: string): void {
  fs.mkdirSync(versionsDir(dataDir, 'types', 'empty'), { recursive: true });
}

const MALFORMED_VERSIONS = [
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
];

const ESCAPING_NAMES = ['..', 'a/b', 'A', '', '.hidden'];

type Store = ReturnType<typeof createDefinitionStore>;

/** Cada operação recusada antes de qualquer I/O, por entrada que sai do layout ou do formato. */
const REFUSALS: { operation: string; input: string; call: (store: Store) => unknown }[] = [
  ...MALFORMED_VERSIONS.flatMap((version) => [
    {
      operation: 'write',
      input: `the malformed version ${JSON.stringify(version)}`,
      call: (store: Store) => store.write(PROJECT, 'types', 'plan', version, plan),
    },
    {
      operation: 'read',
      input: `the malformed version ${JSON.stringify(version)}`,
      call: (store: Store) => store.read(PROJECT, 'types', 'plan', version),
    },
  ]),
  ...ESCAPING_NAMES.flatMap((name) => [
    {
      operation: 'write',
      input: `the project ${JSON.stringify(name)}, which escapes the layout`,
      call: (store: Store) => store.write(name, 'types', 'plan', '1.0', plan),
    },
    {
      operation: 'write',
      input: `the name ${JSON.stringify(name)}, which escapes the layout`,
      call: (store: Store) => store.write(PROJECT, 'types', name, '1.0', plan),
    },
    {
      operation: 'versions',
      input: `the name ${JSON.stringify(name)}, which escapes the layout`,
      call: (store: Store) => store.versions(PROJECT, 'types', name),
    },
    {
      operation: 'names',
      input: `the project ${JSON.stringify(name)}, which escapes the layout`,
      call: (store: Store) => store.names(name, 'types'),
    },
  ]),
];

describe('createDefinitionStore', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return true when writing the first version of each kind of definition', () => {
    const { store } = setup();

    expect(store.write(PROJECT, 'types', 'plan', '1.0', plan)).toBe(true);
    expect(store.write(PROJECT, 'relations', 'approves', '1.0', relation)).toBe(true);
    expect(store.write(PROJECT, 'gates', 'plan-ready', '1.0', gate)).toBe(true);
  });

  it('should read back each kind of definition as it was written', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    store.write(PROJECT, 'relations', 'approves', '1.0', relation);
    store.write(PROJECT, 'gates', 'plan-ready', '1.0', gate);

    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    expect(store.read(PROJECT, 'relations', 'approves', '1.0')).toEqual(relation);
    expect(store.read(PROJECT, 'gates', 'plan-ready', '1.0')).toEqual(gate);
  });

  it('should write the first version of a type at its file in the on-disk layout', () => {
    const { dataDir, store } = setup();

    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(fs.existsSync(definitionFile(dataDir, PROJECT, 'types', 'plan', '1.0'))).toBe(true);
  });

  it('should leave no temporary file in the versions folder after a write', () => {
    const { dataDir, store } = setup();

    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(fs.readdirSync(versionsDir(dataDir, 'types', 'plan'))).toEqual([FIRST_VERSION_FILE]);
  });

  it('should list only the name folders of each kind, in alphabetical order', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'review', '1.0', plan);
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    store.write(PROJECT, 'gates', 'plan-ready', '1.0', gate);
    fs.writeFileSync(path.join(dataRoot(dataDir), PROJECT, 'types', 'stray.json'), '{}');

    expect(store.names(PROJECT, 'types')).toEqual(['plan', 'review']);
    expect(store.names(PROJECT, 'gates')).toEqual(['plan-ready']);
  });

  it('should list no names for a kind with nothing written', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(store.names(PROJECT, 'relations')).toEqual([]);
  });

  it('should list no names for an unknown project', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(store.names('other', 'types')).toEqual([]);
  });

  it('should list a name folder left without any version by a failed write', () => {
    const { dataDir, store } = setup();
    plantEmptyNameFolder(dataDir);

    expect(store.names(PROJECT, 'types')).toEqual(['empty']);
  });

  it('should list no versions for a name folder left without any version by a failed write', () => {
    const { dataDir, store } = setup();
    plantEmptyNameFolder(dataDir);

    expect(store.versions(PROJECT, 'types', 'empty')).toEqual([]);
  });

  it('should order the versions by major and minor as numbers, not as text', () => {
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

  it('should list no versions for a name without any written version', () => {
    const { store } = setup();

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual([]);
  });

  it('should ignore a temporary file, a file outside the pattern and a directory in the versions', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    const dir = versionsDir(dataDir, 'types', 'plan');
    fs.writeFileSync(path.join(dir, '.1.1.json.123.abcd'), '{}');
    fs.writeFileSync(path.join(dir, '01.0.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    fs.mkdirSync(path.join(dir, '2.0.json'));

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual(['1.0']);
  });

  it('should return false when the same version is written a second time', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    const rewritten = store.write(PROJECT, 'types', 'plan', '1.0', planV2);

    expect(rewritten).toBe(false);
  });

  it('should keep the bytes when the same version is written a second time', () => {
    const { dataDir, store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    const file = definitionFile(dataDir, PROJECT, 'types', 'plan', '1.0');
    const before = fs.readFileSync(file);

    store.write(PROJECT, 'types', 'plan', '1.0', planV2);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(versionsDir(dataDir, 'types', 'plan'))).toEqual([FIRST_VERSION_FILE]);
  });

  it('should write another version of the same name without touching the previous one', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    const written = store.write(PROJECT, 'types', 'plan', '1.1', planV2);

    expect(written).toBe(true);
    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);
    expect(store.read(PROJECT, 'types', 'plan', '1.1')).toEqual(planV2);
  });

  it('should fsync the directory once on the write that publishes the version', () => {
    const { store } = setup();
    const fsyncs = countFsyncs();

    store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(fsyncs().directories).toBe(1);
  });

  it('should not fsync the directory on a repeated write (EEXIST)', () => {
    const { store } = setup();
    store.write(PROJECT, 'types', 'plan', '1.0', plan);
    const fsyncs = countFsyncs();

    store.write(PROJECT, 'types', 'plan', '1.0', planV2);

    expect(fsyncs().directories).toBe(0);
  });

  it('should let only one writer win when a rival publishes between the temporary file and the link', () => {
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

  it('should ignore a legacy <name>.json in names', () => {
    const { dataDir, store } = setup();
    plantLegacyFiles(dataDir);

    expect(store.names(PROJECT, 'types')).toEqual([]);
  });

  it('should ignore a legacy <name>.json in versions', () => {
    const { dataDir, store } = setup();
    plantLegacyFiles(dataDir);

    expect(store.versions(PROJECT, 'types', 'plan')).toEqual([]);
  });

  it('should throw TYPE_NOT_FOUND on read when only a legacy <name>.json exists', () => {
    const { dataDir, store } = setup();
    plantLegacyFiles(dataDir);

    expect(captureError(() => store.read(PROJECT, 'types', 'plan', '1.0')).code).toBe(
      'TYPE_NOT_FOUND',
    );
  });

  it('should write the version over a legacy <name>.json without ever materializing the legacy file', () => {
    const { dataDir, store } = setup();
    const legacyFiles = plantLegacyFiles(dataDir);

    const written = store.write(PROJECT, 'types', 'plan', '1.0', plan);

    expect(written).toBe(true);
    expect(store.read(PROJECT, 'types', 'plan', '1.0')).toEqual(plan);

    for (const file of legacyFiles) expect(fs.readFileSync(file, 'utf8')).toBe(LEGACY_BYTES);
  });

  it.each([
    ['types', 'TYPE_NOT_FOUND'],
    ['relations', 'RELATION_NOT_FOUND'],
    ['gates', 'GATE_NOT_FOUND'],
  ] as const)(
    'should throw for a read of a never-existing name in %s with code %s, unknown-name and no absolute path',
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

  it.each([
    ['types', 'TYPE_NOT_FOUND', plan],
    ['relations', 'RELATION_NOT_FOUND', relation],
    ['gates', 'GATE_NOT_FOUND', gate],
  ] as const)(
    'should throw for a read of a missing version in %s with code %s, unknown-version and the existing versions in numeric order',
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

  it('should throw unknown-name, without a list of versions, for a name folder without any version', () => {
    const { dataDir, store } = setup();
    plantEmptyNameFolder(dataDir);

    const error = captureError(() => store.read(PROJECT, 'types', 'empty', '1.0'));

    expect(error.details).toEqual([
      { path: '/name', code: 'unknown-name', message: 'definition name not found' },
    ]);
  });

  it.each(REFUSALS)('should refuse $operation with $input before any I/O', ({ call }) => {
    const { dataDir, store } = setup();

    const error = captureError(() => call(store));

    expect(error.code).toBe('INVALID_INPUT');
    expect(fs.existsSync(dataRoot(dataDir))).toBe(false);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a definition outside the schema', JSON.stringify({ name: 'x', kind: 'not-a-kind' })],
  ])('should throw INTERNAL without the content for a version file with %s', (_, content) => {
    const { dataDir, store } = setup();
    const dir = versionsDir(dataDir, 'relations', 'approves');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FIRST_VERSION_FILE), content);

    const error = captureError(() => store.read(PROJECT, 'relations', 'approves', '1.0'));

    expect(error.code).toBe('INTERNAL');
    expect(error.details[0]?.code).toBe('unreadable-definition');

    expectNoLeak(error, dataDir);
  });

  it.each([
    ['types', 'big-type', { type: 'object', description: 'x'.repeat(17_000) }],
    ['relations', 'approves', { ...relation, kind: 'not-a-kind' }],
    ['gates', 'plan-ready', { ...gate, questions: [] }],
  ] as const)(
    'should throw INTERNAL and store nothing when write gets a definition the schema refuses (%s)',
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

  it('should turn an fs error into IO_ERROR with only the lowercase errno and no path', () => {
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
