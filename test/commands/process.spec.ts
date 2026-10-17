import * as fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { omit } from 'es-toolkit';
import { createDefinitionStore } from '../../src/adapters/fs/definition-store.ts';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { createProcessStore, MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import { createProcessService } from '../../src/commands/process.ts';
import { sha256hex } from '../../src/domain/chain.ts';
import { RESERVED_PROCESS_NAMES, type Name } from '../../src/domain/ids.ts';
import type { Manifest } from '../../src/domain/manifest.ts';
import { HexlogError, type Detail, type ErrorCode } from '../../src/errors.ts';
import type {
  DefinitionKind,
  DefinitionOf,
  DefinitionStore,
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
  // Sem protótipo: um nome como `constructor` não pode ler `Object.prototype`.
  const data: Record<DefinitionKind, Versions> = {
    types: Object.create(null) as Versions,
    relations: Object.create(null) as Versions,
    gates: Object.create(null) as Versions,
  };
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

/** `ProcessStore` em memória: só `create` e `readManifest`, que é o que `createProcess` usa. */
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
    readManifest: (ref) => {
      const manifest = manifests.get(ref.process);
      if (manifest === undefined) throw new Error(`sem processo ${ref.process}`);
      return manifest;
    },
    read: refuse,
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

describe('createProcess', () => {
  describe('when the process is new', () => {
    it('should pin the current version of each type, relation and gate, with the JCS hashes of each block (D-18)', () => {
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
        lineageInheritance: true,
        pinned: { types: ['note'], relations: ['based-on'], gates: ['ready'] },
      });
      expect(processes.manifests.get('run-1')).toEqual({
        project: PROJECT,
        process: 'run-1',
        createdAt: NOW.toISOString(),
        lineageInheritance: true,
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

    it('should read only the current version of each name, not the earlier ones (D-18)', () => {
      const { service, definitions } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      definitions.add('types', 'note', '1.1', NOTE_1_1);

      create(service);

      expect(definitions.reads).toEqual(['types/note@1.1']);
    });

    it.each<[DefinitionKind, Name, DefinitionOf[DefinitionKind]]>([
      ['types', 'note', NOTE_1_0],
      ['relations', 'based-on', SUPPORTS],
      ['gates', 'ready', GATE],
    ])(
      'should create the process in a project with only %s registered (D-18)',
      (kind, name, definition) => {
        const { service, definitions } = setup();
        definitions.add(kind, name, '1.0', definition);

        expect(create(service)).toMatchObject({ created: true, pinned: { [kind]: [name] } });
      },
    );

    it('should keep out of the manifest a name with no version, a folder left over from a failure (D-18)', () => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      definitions.addEmptyName('types', 'orphan');

      create(service);

      expect(Object.keys(processes.manifests.get('run-1')?.fixed.types ?? {})).toEqual(['note']);
    });
  });

  describe('when a refusal applies', () => {
    it.each(RESERVED_PROCESS_NAMES)(
      'should refuse the reserved name %s, before reading a definition or creating',
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

    it.each([
      ['project', { project: 'Not Valid', process: 'run-1' }, '/project'],
      ['process', { project: PROJECT, process: 'Not_Valid' }, '/process'],
    ])(
      'should refuse an invalid %s name with INVALID_INPUT invalid-name coming out of the ports',
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

    it('should refuse a project with no definitions with TYPE_NOT_FOUND, creating nothing', () => {
      const { service, processes } = setup();

      const error = captureError(() => create(service));

      expect(error).toMatchObject({
        code: 'TYPE_NOT_FOUND',
        message: expect.stringContaining('call define_type first'),
        details: [{ path: '/project', code: 'unknown-name' }],
      });
      expect(processes.creates).toEqual([]);
    });

    it('should refuse a project left without definitions with TYPE_NOT_FOUND even with the process already created, instead of created: false', () => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      definitions.store.names = () => [];

      const error = captureError(() => create(service));

      expect(error).toMatchObject({
        code: 'TYPE_NOT_FOUND',
        details: [{ path: '/project', code: 'unknown-name' }],
      });
      expect(processes.creates).toHaveLength(1);
    });

    it('should not count a name folder without a version as a registered definition', () => {
      const { service, definitions, processes } = setup();
      definitions.addEmptyName('types', 'orphan');

      const error = captureError(() => create(service));

      expect(error).toMatchObject({ code: 'TYPE_NOT_FOUND' });
      expect(processes.creates).toEqual([]);
    });

    it.each<[ErrorCode, string, Detail]>([
      [
        'TYPE_NOT_FOUND',
        'unknown-name',
        { path: '/name', code: 'unknown-name', message: 'unknown type' },
      ],
      [
        'GATE_NOT_FOUND',
        'unknown-version',
        {
          path: '/version',
          code: 'unknown-version',
          message: 'unknown version',
          versions: ['1.0'],
        },
      ],
    ])(
      'should let a definition that vanishes between listing and reading (%s, %s) come out intact, creating nothing',
      (code, _subcode, detail) => {
        const { service, definitions, processes } = setup();
        definitions.add('types', 'note', '1.0', NOTE_1_0);
        const failing = new HexlogError(code, detail.message, [detail]);
        definitions.store.read = () => {
          throw failing;
        };

        const error = captureError(() => create(service));

        expect(error).toBe(failing);
        expect(processes.creates).toEqual([]);
      },
    );
  });

  describe('when the process already exists', () => {
    it('should return no lineageInheritance for a legacy manifest that lacks it, and not rewrite the manifest', () => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      const legacy = omit(processes.store.readManifest({ project: PROJECT, process: 'run-1' }), [
        'lineageInheritance',
      ]);
      processes.manifests.set('run-1', legacy);

      const result = create(service);

      expect(result).toEqual({
        project: PROJECT,
        process: 'run-1',
        created: false,
        pinned: { types: ['note'], relations: [], gates: [] },
      });
      expect(result).not.toHaveProperty('lineageInheritance');
      expect(processes.manifests.get('run-1')).toBe(legacy);
    });

    it('should return created false, no stale and the manifest untouched when the definitions are the same', () => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      const first = processes.manifests.get('run-1');

      const result = create(service);

      expect(result).toEqual({
        project: PROJECT,
        process: 'run-1',
        created: false,
        lineageInheritance: true,
        pinned: { types: ['note'], relations: [], gates: [] },
      });
      expect(processes.manifests.get('run-1')).toBe(first);
    });

    it('should return created false and stale with the current version of each when a type, relation and gate have a new version', () => {
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

    it('should mark as stale and keep out of pinned a definition created after the pinning', () => {
      const { service, definitions } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      definitions.add('types', 'task', '1.0', NOTE_1_0);

      const result = create(service);

      expect(result.pinned.types).toEqual(['note']);
      expect(result.stale).toEqual([{ kind: 'types', name: 'task', current: '1.0' }]);
    });

    it('should list in stale only what changed', () => {
      const { service, definitions } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      definitions.add('types', 'task', '1.0', NOTE_1_0);
      create(service);
      definitions.add('types', 'task', '1.1', NOTE_1_1);

      expect(create(service).stale).toEqual([{ kind: 'types', name: 'task', current: '1.1' }]);
    });

    it('should mark as stale a name `constructor` created after the pinning, without reading the prototype', () => {
      const { service, definitions } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      definitions.add('types', 'constructor', '1.0', NOTE_1_0);

      expect(create(service).stale).toEqual([
        { kind: 'types', name: 'constructor', current: '1.0' },
      ]);
    });

    it('should mark as stale with current null a pinned name that no longer has a version in the project', () => {
      const { service, definitions } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      definitions.add('types', 'task', '1.0', NOTE_1_0);
      create(service);
      const versionsOf = definitions.store.versions.bind(definitions.store);
      definitions.store.versions = (project, kind, name) =>
        name === 'note' ? [] : versionsOf(project, kind, name);

      expect(create(service).stale).toEqual([{ kind: 'types', name: 'note', current: null }]);
    });

    it('should let a PROCESS_CORRUPTED unreadable-manifest bubble up intact, not become created false', () => {
      const { service, definitions, processes } = setup();
      definitions.add('types', 'note', '1.0', NOTE_1_0);
      create(service);
      const message = 'process manifest is unreadable';
      const corrupted = new HexlogError('PROCESS_CORRUPTED', message, [
        { path: '/process', code: 'unreadable-manifest', message, process: 'run-1' },
      ]);
      processes.store.readManifest = () => {
        throw corrupted;
      };

      expect(captureError(() => create(service))).toBe(corrupted);
    });

    it('should return created false with the log above the cap, reading only the manifest', () => {
      const dataDir = createTempDir('create-process');
      const definitions = createDefinitionStore({ dataDir });
      definitions.write(PROJECT, 'types', 'note', '1.0', NOTE_1_0);
      const service = createProcessService({
        store: createProcessStore({ dataDir, log: () => undefined }),
        definitions,
        ...UNUSED_REGISTER_PORTS,
        clock: () => NOW,
      });
      create(service);
      fs.truncateSync(
        processPaths(dataDir, { project: PROJECT, process: 'run-1' }).log,
        MAX_LOG_BYTES + 1,
      );

      expect(create(service)).toMatchObject({ created: false, pinned: { types: ['note'] } });
    });
  });
});
