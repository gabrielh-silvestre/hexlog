import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Defined } from '../src/commands/definition.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { definitionOf, namesIn } from './flow-data.ts';
import { at } from './helpers.ts';
import { NOTE_SCHEMA, createEnvironment, type Environment } from './mcp/environment.ts';

const PROJECT = 'authorship';
const REFERENCES_DIR = path.join(__dirname, '..', 'skills', 'hexlog-setup', 'references');
const PACKAGE_DIR = path.join(REFERENCES_DIR, 'decision-authorship');
const PROCEDURE_FILE = path.join(REFERENCES_DIR, 'decision-authorship.md');

const EVIDENCE_TYPES = ['convergence', 'doc-author', 'external-team', 'own-judgment'] as const;
const TYPES = [...EVIDENCE_TYPES, 'approval'].sort();
const RELATIONS = ['approves', 'backs'];
const SUMMARY_MAX = 300;
const DECISION_SCHEMA = {
  type: 'object',
  properties: { choice: { type: 'string' } },
  required: ['choice'],
  additionalProperties: false,
};

let environment: Environment;

const openEnvironment = async () => {
  environment = await createEnvironment();
};
const closeEnvironment = async () => {
  await environment.close();
};

const defineType = (name: string, schema: Record<string, unknown>) =>
  environment.ok<Defined>('define_type', { project: PROJECT, name, schema });

const defineRelation = (name: string) =>
  environment.ok<Defined>('define_relation', {
    project: PROJECT,
    ...definitionOf('relations', name, PACKAGE_DIR),
  });

/** Define o tipo do pacote pelo `define_type`: o corpo do arquivo é o schema. */
const definePackageType = (name: string) =>
  defineType(name, definitionOf('types', name, PACKAGE_DIR));

/** O pacote inteiro mais `decision` e `note`, que o projeto de destino já tem. */
async function definePackage() {
  await defineType('decision', DECISION_SCHEMA);
  await defineType('note', NOTE_SCHEMA);
  for (const name of TYPES) await definePackageType(name);
  for (const name of RELATIONS) await defineRelation(name);
}

const registerBatch = (records: Record<string, unknown>[]) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process: 'unit-1',
    agent: 'test-engineer',
    records,
  });

const registerOne = async (record: Record<string, unknown>) =>
  at((await registerBatch([record])).records, 0).id;

const refuse = (record: Record<string, unknown>) =>
  environment.fail(
    'register',
    { project: PROJECT, process: 'unit-1', agent: 'test-engineer', records: [record] },
    'INVALID_RECORD',
  );

const decisionRecord = (short = 'a') => ({
  type: 'decision',
  target: `unit-1.decision.${short}`,
  data: { choice: short },
});

const evidenceRecord = (type: string, data: Record<string, unknown> = { summary: 'basis' }) => ({
  type,
  target: `unit-1.basis.${type}`,
  data,
});

const readFile = (file: string) => fs.readFileSync(file, 'utf8');

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(TYPES)('should accept the package type %s', async (name) => {
    const defined = await definePackageType(name);

    expect(defined).toMatchObject({ name, created: true });
  });
});

describe('define_relation', () => {
  beforeEach(async () => {
    await openEnvironment();
    await defineType('decision', DECISION_SCHEMA);
    for (const name of TYPES) await definePackageType(name);
  });
  afterEach(closeEnvironment);

  it.each(RELATIONS)('should accept the package relation %s', async (name) => {
    const defined = await defineRelation(name);

    expect(defined).toMatchObject({ name, created: true });
  });
});

describe('register', () => {
  beforeEach(async () => {
    await openEnvironment();
    await definePackage();
    await environment.ok('create_process', { project: PROJECT, process: 'unit-1' });
  });
  afterEach(closeEnvironment);

  it('should accept a human decision supported by own-judgment', async () => {
    const { records } = await registerBatch([
      { ...decisionRecord(), alias: 'choice', decidedBy: 'human' },
      {
        ...evidenceRecord('own-judgment'),
        relations: [{ to: '@choice', as: 'backs' }],
      },
    ]);

    const page = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'unit-1',
      ids: [at(records, 0).id],
      relations: 'full',
    });

    expect(at(page.records, 0).in).toEqual([
      expect.objectContaining({ from: at(records, 1).id, as: 'backs', current: true }),
    ]);
  });

  it('should register own-judgment without a source attachment', async () => {
    const id = await registerOne(evidenceRecord('own-judgment'));

    expect(id).toEqual(expect.any(String));
  });

  it.each(EVIDENCE_TYPES)('should accept a source attachment on %s', async (type) => {
    const { hash } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'full text of the basis',
    });

    const id = await registerOne(evidenceRecord(type, { summary: 'basis', source: hash }));

    expect(id).toEqual(expect.any(String));
  });

  it.each(EVIDENCE_TYPES)(
    'should refuse a source that is not an attachment hash on %s',
    async (type) => {
      const error = await refuse(evidenceRecord(type, { summary: 'basis', source: 'not a hash' }));

      expect(error.details).toEqual([expect.objectContaining({ code: 'format' })]);
    },
  );

  it('should refuse a source on an approval', async () => {
    const { hash } = await environment.ok<{ hash: string }>('attach', {
      project: PROJECT,
      text: 'full text',
    });

    const error = await refuse(evidenceRecord('approval', { summary: 'ok', source: hash }));

    expect(error.details).toEqual([expect.objectContaining({ code: 'additional-properties' })]);
  });

  it.each(TYPES)('should refuse %s without a summary', async (type) => {
    const error = await refuse(evidenceRecord(type, {}));

    expect(error.details).toEqual([expect.objectContaining({ code: 'required' })]);
  });

  it(`should accept a summary of ${SUMMARY_MAX} characters`, async () => {
    const id = await registerOne(
      evidenceRecord('own-judgment', { summary: 'x'.repeat(SUMMARY_MAX) }),
    );

    expect(id).toEqual(expect.any(String));
  });

  it(`should refuse a summary of ${SUMMARY_MAX + 1} characters`, async () => {
    const error = await refuse(
      evidenceRecord('own-judgment', { summary: 'x'.repeat(SUMMARY_MAX + 1) }),
    );

    expect(error.details).toEqual([expect.objectContaining({ code: 'max-length' })]);
  });

  it('should accept approves from an approval to a decision', async () => {
    const decision = await registerOne(decisionRecord());

    const id = await registerOne({
      ...evidenceRecord('approval', { summary: 'approved' }),
      relations: [{ to: decision, as: 'approves' }],
    });

    expect(id).toEqual(expect.any(String));
  });

  it.each([
    { source: 'note', relation: 'backs' },
    { source: 'approval', relation: 'backs' },
    { source: 'own-judgment', relation: 'approves' },
    { source: 'note', relation: 'approves' },
  ] as const)(
    'should refuse $relation from a $source with endpoint-type',
    async ({ source, relation }) => {
      const decision = await registerOne(decisionRecord());
      const data = source === 'note' ? { text: 'a note' } : { summary: 'basis' };

      const error = await refuse({
        type: source,
        target: `unit-1.basis.${source}`,
        data,
        relations: [{ to: decision, as: relation }],
      });

      expect(error.details).toEqual([expect.objectContaining({ code: 'endpoint-type' })]);
    },
  );

  it.each(['backs', 'approves'])(
    'should refuse %s toward a type other than decision with endpoint-type',
    async (relation) => {
      const note = await registerOne({
        type: 'note',
        target: 'unit-1.note.a',
        data: { text: 'a note' },
      });
      const type = relation === 'backs' ? 'own-judgment' : 'approval';

      const error = await refuse({
        ...evidenceRecord(type),
        relations: [{ to: note, as: relation }],
      });

      expect(error.details).toEqual([expect.objectContaining({ code: 'endpoint-type' })]);
    },
  );
});

describe('skills/hexlog-setup/references/decision-authorship/', () => {
  it('should hold the five types and the two relations and no gate', () => {
    expect({
      types: namesIn('types', PACKAGE_DIR),
      relations: namesIn('relations', PACKAGE_DIR),
      hasGates: fs.existsSync(path.join(PACKAGE_DIR, 'gates')),
    }).toEqual({ types: TYPES, relations: RELATIONS, hasGates: false });
  });

  it.each([
    { name: 'backs', from: [...EVIDENCE_TYPES] },
    { name: 'approves', from: ['approval'] },
  ])('should define $name as supports from $from to decision', ({ name, from }) => {
    const relation = definitionOf('relations', name, PACKAGE_DIR);

    expect({ ...relation, from: [...(relation.from as string[])].sort() }).toEqual({
      name,
      kind: 'supports',
      from,
      to: ['decision'],
    });
  });

  it.each(TYPES)('should require only summary on %s', (name) => {
    const schema = definitionOf('types', name, PACKAGE_DIR);

    expect(schema.required).toEqual(['summary']);
  });

  it.each(TYPES)('should cap the summary of %s at 300 characters', (name) => {
    const schema = definitionOf('types', name, PACKAGE_DIR);

    expect(schema.properties).toMatchObject({
      summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX },
    });
  });

  it.each(EVIDENCE_TYPES)('should declare an optional attachment source on %s', (name) => {
    const schema = definitionOf('types', name, PACKAGE_DIR);

    expect(schema.properties).toMatchObject({ source: { type: 'string', format: 'attachment' } });
  });

  it('should declare no source on approval', () => {
    const schema = definitionOf('types', 'approval', PACKAGE_DIR);

    expect(Object.keys(schema.properties as object)).toEqual(['summary']);
  });

  it('should write the package files in English', () => {
    const files = [
      ...namesIn('types', PACKAGE_DIR).map((name) =>
        path.join(PACKAGE_DIR, 'types', `${name}.json`),
      ),
      ...namesIn('relations', PACKAGE_DIR).map((name) =>
        path.join(PACKAGE_DIR, 'relations', `${name}.json`),
      ),
    ];

    expect(files.map(readFile).join('\n')).not.toMatch(/\P{ASCII}/u);
  });
});

describe('skills/hexlog-setup/references/decision-authorship.md', () => {
  it.each([
    ...TYPES.map((name) => `types/${name}.json`),
    ...RELATIONS.map((name) => `relations/${name}.json`),
  ])('should cite the package file %s', (file) => {
    expect(readFile(PROCEDURE_FILE)).toContain(`\`${file}\``);
  });

  it('should say in the attribution table and next to the example that approval carries agent', () => {
    const sentence =
      'O registro `approval` é evidência produzida pelo agente: leva `agent` (herda o lote); o ato humano de aprovar está no `summary`.';

    expect(readFile(PROCEDURE_FILE).split(sentence)).toHaveLength(3);
  });

  it('should say that the report finds the basis by the supports kind, so a mapped relation name works', () => {
    expect(readFile(PROCEDURE_FILE)).toContain(
      'identifica a base pela espécie `supports` (aresta vinda de um dos quatro tipos de evidência), então vale com o nome da relação mapeado',
    );
  });

  it('should not tell the agent to run node scripts/install.ts', () => {
    expect(readFile(PROCEDURE_FILE)).not.toContain('node scripts/install.ts');
  });
});
