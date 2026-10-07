import { describe, expect, test } from '@jest/globals';
import canonicalize from 'canonicalize';
import { omit } from 'es-toolkit';
import { createValidator } from '../../src/adapters/validator.ts';
import { createDefinitionService } from '../../src/commands/definition.ts';
import type {
  DefineGateInput,
  DefineRelationInput,
  Defined,
} from '../../src/commands/definition.ts';
import { hashOfJcs } from '../../src/domain/chain.ts';
import { compareVersions } from '../../src/domain/definitions.ts';
import type { Gate, RecordType, RelationName } from '../../src/domain/definitions.ts';
import type { DefinitionKind, DefinitionOf, DefinitionStore } from '../../src/ports.ts';
import { captureError } from '../helpers.ts';
import { refuse } from './register-fakes.ts';

const PROJECT = 'alpha';
const NAME = 'note';

const BASE_SCHEMA: RecordType = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};
const WITH_OPTIONAL: RecordType = {
  ...BASE_SCHEMA,
  properties: { title: { type: 'string' }, body: { type: 'string' } },
};
const WITH_REQUIRED: RecordType = { ...WITH_OPTIONAL, required: ['title', 'body'] };

const QUESTION: Gate['questions'][number] = { kind: 'no_open_contradiction' };
const OTHER_QUESTION: Gate['questions'][number] = {
  kind: 'occurred',
  select: { type: 'approval' },
};

/**
 * Porta em memória com o contrato de `DefinitionStore.write`: `false` se a versão já existe.
 * `race` roda uma vez no início do próximo `write`, para plantar a versão de um escritor concorrente.
 */
function fakeStore() {
  const files = new Map<string, Map<string, unknown>>();
  const writes: { kind: DefinitionKind; version: string }[] = [];
  let race: (() => void) | undefined;

  const versionsOf = (kind: DefinitionKind, name: string) => {
    const key = `${kind}/${name}`;
    const found = files.get(key) ?? new Map<string, unknown>();
    files.set(key, found);
    return found;
  };
  const store: DefinitionStore = {
    names: refuse,
    versions: (_project, kind, name) => [...versionsOf(kind, name).keys()].sort(compareVersions),
    read: <K extends DefinitionKind>(_project: string, kind: K, name: string, version: string) =>
      versionsOf(kind, name).get(version) as DefinitionOf[K],
    write: (_project, kind, name, version, definition) => {
      writes.push({ kind, version });
      const pending = race;
      race = undefined;
      pending?.();
      const stored = versionsOf(kind, name);
      if (stored.has(version)) return false;
      stored.set(version, structuredClone(definition));
      return true;
    },
  };

  return {
    store,
    writes,
    seed: (kind: DefinitionKind, name: string, version: string, definition: unknown) =>
      void versionsOf(kind, name).set(version, structuredClone(definition)),
    versions: (kind: DefinitionKind, name: string) => store.versions(PROJECT, kind, name),
    stored: (kind: DefinitionKind, name: string, version: string) =>
      versionsOf(kind, name).get(version),
    racing: (plant: () => void) => void (race = plant),
  };
}

function setup() {
  const fake = fakeStore();
  const service = createDefinitionService({ store: fake.store, validator: createValidator() });
  return { ...fake, service };
}

const relation = (overrides: Partial<DefineRelationInput> = {}): DefineRelationInput => ({
  project: PROJECT,
  name: 'backs',
  kind: 'supports',
  from: ['note'],
  to: ['note', 'decision'],
  ...overrides,
});

const gate = (overrides: Partial<DefineGateInput> = {}): DefineGateInput => ({
  project: PROJECT,
  name: 'ready',
  questions: [QUESTION],
  ...overrides,
});

/** Relação de exatamente `chars` caracteres canônicos: `from` de nomes distintos de 40 caracteres (43 canônicos cada) e um `name` que acerta o resto. */
function relationOfLength(chars: number): DefineRelationInput {
  for (let count = 1; ; count += 1) {
    const from = Array.from({ length: count }, (_, i) => `t${i}`.padEnd(40, 'x'));
    const rest = chars - canonicalize(omit(relation({ from }), ['project']))!.length;
    if (rest >= 0 && rest <= 58) return relation({ from, name: 'b'.repeat(5 + rest) });
  }
}

describe('defineType: versões imutáveis', () => {
  test('primeira versão é 1.0, com o hash do schema canônico', () => {
    const { service, stored } = setup();

    const defined = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

    expect(defined).toEqual({
      name: NAME,
      version: '1.0',
      hash: hashOfJcs(BASE_SCHEMA),
      created: true,
    });
    expect(stored('types', NAME, '1.0')).toEqual(BASE_SCHEMA);
  });

  test('propriedade opcional nova sobe a minor e guarda a anterior', () => {
    const { service, versions } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

    const defined = service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

    expect(defined).toMatchObject({ version: '1.1', created: true, previousVersion: '1.0' });
    expect(versions('types', NAME)).toEqual(['1.0', '1.1']);
  });

  test('quebra sem breaking: true é recusada e nada é gravado', () => {
    const { service, writes } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });
    writes.length = 0;

    const error = captureError(() =>
      service.defineType({ project: PROJECT, name: NAME, schema: WITH_REQUIRED }),
    );

    expect(error).toMatchObject({
      code: 'BREAKING_CHANGE',
      details: [{ path: '/schema', code: 'breaking-change' }],
    });
    expect(writes).toEqual([]);
  });

  test('breaking: true sobe o major e zera a minor', () => {
    const { service, versions } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
    service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

    const defined = service.defineType({
      project: PROJECT,
      name: NAME,
      schema: WITH_REQUIRED,
      breaking: true,
    });

    expect(defined).toMatchObject({ version: '2.0', previousVersion: '1.1' });
    expect(versions('types', NAME)).toEqual(['1.0', '1.1', '2.0']);
  });

  test('breaking: true sem mudança quebrada também sobe o major, sem aviso', () => {
    const { service } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

    const defined = service.defineType({
      project: PROJECT,
      name: NAME,
      schema: WITH_OPTIONAL,
      breaking: true,
    });

    expect(defined).toMatchObject({ version: '2.0', created: true });
  });
});

describe('defineRelation e defineGate: mesmo motor de versão', () => {
  test('relação: alargar from/to sobe a minor; estreitar é quebra', () => {
    const { service, versions } = setup();
    service.defineRelation(relation());

    const widened = service.defineRelation(relation({ to: ['note', 'decision', 'review'] }));
    const error = captureError(() => service.defineRelation(relation({ to: ['note'] })));

    expect(widened).toMatchObject({ version: '1.1', previousVersion: '1.0' });
    expect(error).toMatchObject({ code: 'BREAKING_CHANGE' });
    expect(versions('relations', 'backs')).toEqual(['1.0', '1.1']);
  });

  test('relação sem from/to grava só o que veio, sem chave undefined', () => {
    const { service, stored } = setup();

    service.defineRelation({ project: PROJECT, name: 'backs', kind: 'supports' });

    expect(stored('relations', 'backs', '1.0')).toStrictEqual({ name: 'backs', kind: 'supports' });
  });

  test('gate: qualquer mudança é minor; só breaking: true sobe o major', () => {
    const { service } = setup();
    service.defineGate(gate());

    const changed = service.defineGate(gate({ questions: [QUESTION, OTHER_QUESTION] }));
    const flagged = service.defineGate(gate({ questions: [OTHER_QUESTION], breaking: true }));

    expect(changed).toMatchObject({ version: '1.1', previousVersion: '1.0' });
    expect(flagged).toMatchObject({ version: '2.0', previousVersion: '1.1' });
  });

  test('os três define* de mesmo nome não se misturam', () => {
    const { service, versions } = setup();

    service.defineType({ project: PROJECT, name: 'same', schema: BASE_SCHEMA });
    service.defineRelation(relation({ name: 'same' }));
    service.defineGate(gate({ name: 'same' }));

    expect(versions('types', 'same')).toEqual(['1.0']);
    expect(versions('relations', 'same')).toEqual(['1.0']);
    expect(versions('gates', 'same')).toEqual(['1.0']);
  });
});

describe('replay idempotente', () => {
  test('mesma definição outra vez devolve a versão vigente sem gravar', () => {
    const { service, writes } = setup();
    const first = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
    writes.length = 0;

    const replay = service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });

    expect(replay).toEqual({ ...first, created: false });
    expect(writes).toEqual([]);
  });

  test.each([
    ['relação', (s: ReturnType<typeof setup>['service']) => s.defineRelation(relation())],
    ['gate', (s: ReturnType<typeof setup>['service']) => s.defineGate(gate())],
  ])('%s: mesma definição outra vez é replay', (_kind, define) => {
    const { service, writes } = setup();
    const first = define(service);
    writes.length = 0;

    const replay = define(service);

    expect(replay).toEqual({ ...first, created: false });
    expect(writes).toEqual([]);
  });

  test.each<[string, (s: ReturnType<typeof setup>['service']) => Defined, DefinitionKind, string]>([
    [
      'tipo',
      (s) => s.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA, breaking: true }),
      'types',
      NAME,
    ],
    ['gate', (s) => s.defineGate(gate({ breaking: true })), 'gates', 'ready'],
  ])(
    '%s: breaking: true com a definição idêntica à vigente é replay, sem subir a major',
    (_kind, define, kind, name) => {
      const { service, writes, versions } = setup();
      const first = define(service);
      writes.length = 0;

      const replay = define(service);

      expect(replay).toEqual({ ...first, created: false });
      expect(replay.version).toBe('1.0');
      expect(writes).toEqual([]);
      expect(versions(kind, name)).toEqual(['1.0']);
    },
  );
});

describe('escritor concorrente ocupa a versão alvo', () => {
  test('primeira versão de nome novo com breaking: true converge para 1.0 como replay', () => {
    const { service, seed, racing, versions } = setup();
    racing(() => seed('types', NAME, '1.0', BASE_SCHEMA));

    const defined = service.defineType({
      project: PROJECT,
      name: NAME,
      schema: BASE_SCHEMA,
      breaking: true,
    });

    expect(defined).toEqual({
      name: NAME,
      version: '1.0',
      hash: hashOfJcs(BASE_SCHEMA),
      created: false,
    });
    expect(versions('types', NAME)).toEqual(['1.0']);
  });

  test('mesma definição gravada por outro escritor vira replay', () => {
    const { service, seed, racing, versions } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
    racing(() => seed('types', NAME, '1.1', WITH_OPTIONAL));

    const defined = service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL });

    expect(defined).toEqual({
      name: NAME,
      version: '1.1',
      hash: hashOfJcs(WITH_OPTIONAL),
      created: false,
    });
    expect(versions('types', NAME)).toEqual(['1.0', '1.1']);
  });

  test('definição diferente é decidida de novo e nunca sobrescreve a do outro escritor', () => {
    const { service, seed, racing, stored } = setup();
    service.defineGate(gate());
    racing(() => seed('gates', 'ready', '1.1', { name: 'ready', questions: [OTHER_QUESTION] }));

    const defined = service.defineGate(gate({ questions: [QUESTION, OTHER_QUESTION] }));

    expect(defined).toMatchObject({
      version: '1.2',
      created: true,
      previousVersion: '1.1',
      divergentVersions: ['1.1'],
    });
    expect(stored('gates', 'ready', '1.1')).toEqual({ name: 'ready', questions: [OTHER_QUESTION] });
  });

  test('o que o outro escritor gravou pode tornar a mudança uma quebra', () => {
    const { service, seed, racing } = setup();
    service.defineType({ project: PROJECT, name: NAME, schema: BASE_SCHEMA });
    racing(() => seed('types', NAME, '1.1', WITH_REQUIRED));

    const error = captureError(() =>
      service.defineType({ project: PROJECT, name: NAME, schema: WITH_OPTIONAL }),
    );

    expect(error).toMatchObject({ code: 'BREAKING_CHANGE' });
  });

  test('versão alvo que nunca libera esgota as tentativas, sem sobrescrever', () => {
    const { store, seed } = setup();
    seed('gates', 'ready', '1.0', { name: 'ready', questions: [QUESTION] });
    // `write` sempre acha a versão alvo ocupada, e a leitura nunca vê o que o outro escritor gravou.
    let writes = 0;
    const stuck: DefinitionStore = {
      ...store,
      write: () => {
        writes += 1;
        return false;
      },
    };

    const error = captureError(() =>
      createDefinitionService({ store: stuck, validator: createValidator() }).defineGate(
        gate({ questions: [OTHER_QUESTION] }),
      ),
    );

    expect(error).toMatchObject({
      code: 'INTERNAL',
      details: [{ code: 'exclusive-write-exhausted' }],
    });
    expect(writes).toBe(10);
  });
});

describe('definição fora do teto ou da forma não chega a gravar', () => {
  test('defineGate com 0 e com 51 perguntas', () => {
    const { service, writes } = setup();
    const fiftyOne = Array.from({ length: 51 }, () => QUESTION);

    const none = captureError(() => service.defineGate(gate({ questions: [] })));
    const tooMany = captureError(() => service.defineGate(gate({ questions: fiftyOne })));

    expect(none).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/questions' }] });
    expect(tooMany).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/questions' }] });
    expect(writes).toEqual([]);
  });

  test('defineGate com 50 perguntas ainda grava', () => {
    const { service } = setup();

    const defined = service.defineGate(
      gate({ questions: Array.from({ length: 50 }, () => QUESTION) }),
    );

    expect(defined).toMatchObject({ version: '1.0', created: true });
  });

  test('defineType com schema de 16.001 caracteres canônicos', () => {
    const { service, writes } = setup();
    // 34 caracteres de moldura canônica + o texto: 15.967 fecha em 16.001.
    const schema: RecordType = { type: 'object', description: 'x'.repeat(15_967) };
    expect(canonicalize(schema)).toHaveLength(16_001);

    const error = captureError(() => service.defineType({ project: PROJECT, name: NAME, schema }));

    expect(error).toMatchObject({ code: 'INVALID_SCHEMA', details: [{ path: '/schema' }] });
    expect(writes).toEqual([]);
  });

  test('defineType com schema de 16.000 caracteres canônicos ainda grava', () => {
    const { service } = setup();
    const schema: RecordType = { type: 'object', description: 'x'.repeat(15_966) };
    expect(canonicalize(schema)).toHaveLength(16_000);

    const defined = service.defineType({ project: PROJECT, name: NAME, schema });

    expect(defined).toMatchObject({ version: '1.0', created: true });
  });

  test('defineRelation com 16.001 caracteres canônicos', () => {
    const { service, writes } = setup();
    const input = relationOfLength(16_001);
    expect(canonicalize(omit(input, ['project']))).toHaveLength(16_001);

    const error = captureError(() => service.defineRelation(input));

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ message: expect.stringContaining('relation exceeds 16000') }],
    });
    expect(writes).toEqual([]);
  });

  test('defineGate com 16.001 caracteres canônicos', () => {
    const { service, writes } = setup();
    const withText = (text: string) =>
      gate({ questions: [{ kind: 'occurred', select: { where: { text } } }] });
    const base = canonicalize(omit(withText(''), ['project']))!.length;
    const input = withText('x'.repeat(16_001 - base));
    expect(canonicalize(omit(input, ['project']))).toHaveLength(16_001);

    const error = captureError(() => service.defineGate(input));

    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      details: [{ message: expect.stringContaining('gate exceeds 16000') }],
    });
    expect(writes).toEqual([]);
  });

  test.each([
    ['array', { type: 'array', items: { type: 'string' } }],
    ['sem type', { description: 'sem type na raiz' }],
  ])('defineType com raiz %s', (_root, schema) => {
    const { service, writes } = setup();

    const error = captureError(() => service.defineType({ project: PROJECT, name: NAME, schema }));

    expect(error).toMatchObject({
      code: 'INVALID_SCHEMA',
      details: [{ path: '/schema/type', code: 'invalid-type' }],
    });
    expect(writes).toEqual([]);
  });

  test('defineRelation com from vazio', () => {
    const { service, writes } = setup();

    const error = captureError(() => service.defineRelation(relation({ from: [] })));

    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/from' }] });
    expect(writes).toEqual([]);
  });

  test('defineRelation com kind desconhecido', () => {
    const { service, writes } = setup();
    const unknown = relation({ kind: 'invented' as RelationName['kind'] });

    const error = captureError(() => service.defineRelation(unknown));

    expect(error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: '/kind' }] });
    expect(writes).toEqual([]);
  });
});

describe('defineType: checkSchema do validador', () => {
  test.each([
    [
      'pattern perigoso',
      { code: { type: 'string', maxLength: 10, pattern: '(a+)+$' } },
      '/schema/properties/code/pattern',
    ],
    [
      'pattern sem maxLength',
      { code: { type: 'string', pattern: '^[a-z]+$' } },
      '/schema/properties/code/pattern',
    ],
    [
      'valor que viola o metaschema',
      { code: { minLength: -1 } },
      '/schema/properties/code/minLength',
    ],
  ])(
    '%s devolve invalid-schema com o path prefixado com /schema e não grava',
    (_name, properties, path) => {
      const { service, writes } = setup();
      const schema = { type: 'object', properties } as RecordType;

      const error = captureError(() =>
        service.defineType({ project: PROJECT, name: NAME, schema }),
      );

      expect(error).toMatchObject({ code: 'INVALID_SCHEMA', details: [{ path }] });
      expect(writes).toEqual([]);
    },
  );

  test('exceção do ajv aponta exatamente /schema, nunca /schema/schema', () => {
    const { service, writes } = setup();
    const schema: RecordType = { type: 'object', bogus: true };

    const error = captureError(() => service.defineType({ project: PROJECT, name: NAME, schema }));

    expect(error).toMatchObject({
      code: 'INVALID_SCHEMA',
      details: [{ path: '/schema', code: 'invalid-schema' }],
    });
    expect(writes).toEqual([]);
  });

  test('os details do validador saem prefixados com /schema, sem novo corte', () => {
    const { store, writes } = setup();
    const details = Array.from({ length: 51 }, (_, index) => ({
      path: `/properties/p${index}`,
      code: 'type',
      message: 'must be valid',
    }));
    const service = createDefinitionService({
      store,
      validator: { checkSchema: () => details, validate: () => [] },
    });

    const error = captureError(() =>
      service.defineType({ project: PROJECT, name: NAME, schema: { type: 'object' } }),
    );

    expect(error).toMatchObject({
      code: 'INVALID_SCHEMA',
      details: details.map((detail) => ({ ...detail, path: `/schema${detail.path}` })),
    });
    expect(writes).toEqual([]);
  });
});
