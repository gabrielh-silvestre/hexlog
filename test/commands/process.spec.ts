import { describe, expect, test } from '@jest/globals';
import { createDefinitionStore } from '../../src/adapters/fs/definition-store.ts';
import { createProcessStore } from '../../src/adapters/fs/process-store.ts';
import { createProcessService } from '../../src/commands/process.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import { RESERVED_PROCESS_NAMES, type Name } from '../../src/domain/ids.ts';
import { HexlogError, type Detail, type ErrorCode } from '../../src/errors.ts';
import type {
  DefinitionKind,
  DefinitionOf,
  DefinitionStore,
  Manifest,
  ProcessStore,
} from '../../src/ports.ts';
import { captureError, createTempDir } from '../helpers.ts';
import { refuse, UNUSED_REGISTER_PORTS } from './register-fakes.ts';

const PROJECT = 'alpha';
const NOW = new Date('2026-10-02T12:00:00.000Z');

const NOTE_1_0: DefinitionOf['types'] = { type: 'object' };
const NOTE_1_1: DefinitionOf['types'] = {
  type: 'object',
  properties: { text: { type: 'string' } },
};
const SUPPORTS: DefinitionOf['relations'] = { name: 'based-on', kind: 'supports' };
const SUPPORTS_WIDER: DefinitionOf['relations'] = { ...SUPPORTS, from: ['note'] };
const GATE: DefinitionOf['gates'] = {
  name: 'ready',
  questions: [{ kind: 'occurred', select: { type: 'note' } }],
};
const GATE_2: DefinitionOf['gates'] = {
  ...GATE,
  questions: [...GATE.questions, ...GATE.questions],
};

type Versions = Record<string, Record<string, unknown>>;

/** `DefinitionStore` em memória: só leitura, e `add` planta uma versão (a ordem de inserção é a numérica). */
function fakeDefinitions() {
  const data: Record<DefinitionKind, Versions> = { types: {}, relations: {}, gates: {} };
  const reads: string[] = [];
  const store: DefinitionStore = {
    names: (_project, kind) => Object.keys(data[kind]),
    versions: (_project, kind, name) => Object.keys(data[kind][name] ?? {}),
    read: <K extends DefinitionKind>(_project: Name, kind: K, name: Name, version: string) => {
      reads.push(`${kind}/${name}@${version}`);
      return data[kind][name]?.[version] as DefinitionOf[K];
    },
    write: refuse,
  };
  const slot = (kind: DefinitionKind, name: Name) => (data[kind][name] ??= {});
  const add = <K extends DefinitionKind>(
    kind: K,
    name: Name,
    version: string,
    definition: DefinitionOf[K],
  ) => {
    slot(kind, name)[version] = definition;
  };
  const addEmptyName = (kind: DefinitionKind, name: Name) => {
    slot(kind, name);
  };
  return { store, add, addEmptyName, reads };
}

/** `ProcessStore` em memória: só `create` e `read`, que é o que `createProcess` usa. */
function fakeProcesses() {
  const manifests = new Map<string, Manifest>();
  const creates: Manifest[] = [];
  const store: ProcessStore = {
    create: (ref, manifest) => {
      creates.push(manifest);
      if (manifests.has(ref.process)) return false;
      manifests.set(ref.process, manifest);
      return true;
    },
    read: (ref) => {
      const manifest = manifests.get(ref.process);
      if (manifest === undefined) throw new Error(`sem processo ${ref.process}`);
      return { manifest, text: '', endsWithNewline: true };
    },
    list: refuse,
    listProjects: refuse,
    write: refuse,
  };
  return { store, manifests, creates };
}

function setup() {
  const definitions = fakeDefinitions();
  const processes = fakeProcesses();
  const service = createProcessService({
    store: processes.store,
    definitions: definitions.store,
    ...UNUSED_REGISTER_PORTS,
    clock: () => NOW,
  });
  return { service, definitions, processes };
}

const create = (service: ReturnType<typeof setup>['service'], process = 'run-1') =>
  service.createProcess({ project: PROJECT, process });

describe('createProcess: criação (D-18)', () => {
  test('fixa a versão vigente de cada tipo, relação e gate, com os hashes do JCS de cada bloco', () => {
    const { service, definitions, processes } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.add('types', 'note', '1.1', NOTE_1_1);
    definitions.add('relations', 'based-on', '1.0', SUPPORTS);
    definitions.add('gates', 'ready', '1.0', GATE);

    const result = create(service);

    expect(result).toEqual({
      project: PROJECT,
      process: 'run-1',
      created: true,
      pinned: { types: ['note'], relations: ['based-on'], gates: ['ready'] },
    });
    expect(processes.manifests.get('run-1')).toEqual({
      project: PROJECT,
      process: 'run-1',
      createdAt: NOW.toISOString(),
      fixed: {
        types: { note: NOTE_1_1 },
        relations: { 'based-on': SUPPORTS },
        gates: { ready: GATE },
      },
      hashes: {
        types: sha256hex('{"note":{"properties":{"text":{"type":"string"}},"type":"object"}}'),
        relations: sha256hex('{"based-on":{"kind":"supports","name":"based-on"}}'),
        gates: sha256hex(
          '{"ready":{"name":"ready","questions":[{"kind":"occurred","select":{"type":"note"}}]}}',
        ),
      },
    });
  });

  test('só lê a versão vigente de cada nome, não as anteriores', () => {
    const { service, definitions } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.add('types', 'note', '1.1', NOTE_1_1);

    create(service);

    expect(definitions.reads).toEqual(['types/note@1.1']);
  });

  test.each<[DefinitionKind, Name, DefinitionOf[DefinitionKind]]>([
    ['types', 'note', NOTE_1_0],
    ['relations', 'based-on', SUPPORTS],
    ['gates', 'ready', GATE],
  ])('projeto com só %s registrado já cria o processo', (kind, name, definition) => {
    const { service, definitions } = setup();
    definitions.add(kind, name, '1.0', definition);

    expect(create(service)).toMatchObject({ created: true, pinned: { [kind]: [name] } });
  });

  test('nome sem nenhuma versão (pasta que sobrou de uma falha) fica fora do manifesto', () => {
    const { service, definitions, processes } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.addEmptyName('types', 'orphan');

    create(service);

    expect(Object.keys(processes.manifests.get('run-1')?.fixed.types ?? {})).toEqual(['note']);
  });
});

describe('createProcess: recusas', () => {
  test.each(RESERVED_PROCESS_NAMES)(
    'nome reservado %s, antes de ler definição ou criar',
    (name) => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);

      const error = captureError(() => create(service, name));

      expect(error).toMatchObject({
        code: 'RESERVED_NAME',
        details: [{ path: '/process', code: 'reserved-name' }],
      });
      expect(definitions.reads).toEqual([]);
      expect(processes.creates).toEqual([]);
    },
  );

  test.each([
    ['projeto', { project: 'Not Valid', process: 'run-1' }, '/project'],
    ['processo', { project: PROJECT, process: 'Not_Valid' }, '/process'],
  ])(
    'nome de %s inválido sai das portas como INVALID_INPUT invalid-name',
    (_field, input, path) => {
      const dataDir = createTempDir('create-process');
      const definitions = createDefinitionStore({ dataDir });
      definitions.write(PROJECT, 'types', 'note', '1.0', NOTE_1_0);
      const service = createProcessService({
        store: createProcessStore({ dataDir, log: () => undefined }),
        definitions,
        ...UNUSED_REGISTER_PORTS,
        clock: () => NOW,
      });

      const error = captureError(() => service.createProcess(input));

      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        details: [{ path, code: 'invalid-name' }],
      });
    },
  );

  test('projeto sem nenhuma definição recusa com TYPE_NOT_FOUND, sem criar nada', () => {
    const { service, processes } = setup();

    const error = captureError(() => create(service));

    expect(error).toMatchObject({
      code: 'TYPE_NOT_FOUND',
      message: expect.stringContaining('run the setup'),
      details: [{ path: '/project', code: 'unknown-name' }],
    });
    expect(processes.creates).toEqual([]);
  });

  test('pasta de nome sem versão não conta como definição registrada', () => {
    const { service, definitions, processes } = setup();
    definitions.addEmptyName('types', 'orphan');

    expect(captureError(() => create(service))).toMatchObject({ code: 'TYPE_NOT_FOUND' });
    expect(processes.creates).toEqual([]);
  });

  test.each<[ErrorCode, string, Detail]>([
    [
      'TYPE_NOT_FOUND',
      'unknown-name',
      { path: '/name', code: 'unknown-name', message: 'unknown type' },
    ],
    [
      'GATE_NOT_FOUND',
      'unknown-version',
      { path: '/version', code: 'unknown-version', message: 'unknown version', versions: ['1.0'] },
    ],
  ])(
    'definição que some entre a listagem e a leitura (%s, %s) sai intacta, sem criar nada',
    (code, _subcode, detail) => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      const failing = new HexlogError(code, detail.message, [detail]);
      definitions.store.read = () => {
        throw failing;
      };

      expect(captureError(() => create(service))).toBe(failing);
      expect(processes.creates).toEqual([]);
    },
  );
});

describe('createProcess: processo já existente', () => {
  test('mesmas definições: created false, sem stale, manifesto intocado', () => {
    const { service, definitions, processes } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    create(service);
    const first = processes.manifests.get('run-1');

    const result = create(service);

    expect(result).toEqual({
      project: PROJECT,
      process: 'run-1',
      created: false,
      pinned: { types: ['note'], relations: [], gates: [] },
    });
    expect(processes.manifests.get('run-1')).toBe(first);
  });

  test('versão nova de tipo, relação e gate: created false e stale com a vigente de cada um', () => {
    const { service, definitions } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.add('relations', 'based-on', '1.0', SUPPORTS);
    definitions.add('gates', 'ready', '1.0', GATE);
    create(service);
    definitions.add('types', 'note', '1.1', NOTE_1_1);
    definitions.add('relations', 'based-on', '1.1', SUPPORTS_WIDER);
    definitions.add('gates', 'ready', '1.1', GATE_2);

    const result = create(service);

    expect(result).toMatchObject({ created: false, pinned: { types: ['note'] } });
    expect(result.stale).toEqual([
      { kind: 'types', name: 'note', current: '1.1' },
      { kind: 'relations', name: 'based-on', current: '1.1' },
      { kind: 'gates', name: 'ready', current: '1.1' },
    ]);
  });

  test('definição criada depois da fixação é stale e não entra em pinned', () => {
    const { service, definitions } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    create(service);
    definitions.add('types', 'task', '1.0', NOTE_1_0);

    const result = create(service);

    expect(result.pinned.types).toEqual(['note']);
    expect(result.stale).toEqual([{ kind: 'types', name: 'task', current: '1.0' }]);
  });

  test('só o que mudou aparece em stale', () => {
    const { service, definitions } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.add('types', 'task', '1.0', NOTE_1_0);
    create(service);
    definitions.add('types', 'task', '1.1', NOTE_1_1);

    expect(create(service).stale).toEqual([{ kind: 'types', name: 'task', current: '1.1' }]);
  });

  test('nome fixado que não tem mais versão no projeto é stale com current null', () => {
    const { service, definitions } = setup();
    definitions.add('types', 'note', '1.0', NOTE_1_0);
    definitions.add('types', 'task', '1.0', NOTE_1_0);
    create(service);
    const versionsOf = definitions.store.versions.bind(definitions.store);
    definitions.store.versions = (project, kind, name) =>
      name === 'note' ? [] : versionsOf(project, kind, name);

    expect(create(service).stale).toEqual([{ kind: 'types', name: 'note', current: null }]);
  });
});
