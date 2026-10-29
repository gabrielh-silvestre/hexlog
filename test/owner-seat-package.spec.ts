import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Defined } from '../src/commands/definition.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { classifyTypeChange, type RecordType } from '../src/domain/definitions.ts';
import type {
  DescribeTypeResult,
  GateEvaluation,
  QueryResult,
} from '../src/queries/query-service.ts';
import { KINDS, definitionOf, namesIn } from './flow-data.ts';
import { at } from './helpers.ts';
import { NOTE_SCHEMA, createEnvironment, type Environment } from './mcp/environment.ts';

const PROJECT = 'seat';
const PACKAGE_DIR = path.join(
  __dirname,
  '..',
  'skills',
  'hexlog-setup',
  'references',
  'owner-seat',
);
const DEFINE_TOOL = {
  types: 'define_type',
  relations: 'define_relation',
  gates: 'define_gate',
} as const;

const statementOnly = (maxLength: number): RecordType => ({
  type: 'object',
  properties: { statement: { type: 'string', minLength: 1, maxLength } },
  required: ['statement'],
  additionalProperties: false,
});
const STATEMENT_ONLY = statementOnly(255);

const packageType = (name: string) => definitionOf('types', name, PACKAGE_DIR) as RecordType;

let environment: Environment;

const openEnvironment = async () => {
  environment = await createEnvironment();
};
const closeEnvironment = async () => {
  await environment.close();
};

const defineType = (name: string, schema: Record<string, unknown>) =>
  environment.ok<Defined>('define_type', { project: PROJECT, name, schema });

/** Define um arquivo do pacote pela tool do seu tipo: o tipo leva o schema; relação e gate, o corpo com o nome. */
const definePackageFile = (kind: keyof typeof DEFINE_TOOL, name: string) =>
  environment.ok<Defined>(DEFINE_TOOL[kind], {
    project: PROJECT,
    ...(kind === 'types'
      ? { name, schema: packageType(name) }
      : definitionOf(kind, name, PACKAGE_DIR)),
  });

/** Define o pacote inteiro (tipos, relações e gate) e o tipo `note`, que serve de dependente. */
async function definePackage() {
  for (const kind of KINDS) {
    for (const name of namesIn(kind, PACKAGE_DIR)) await definePackageFile(kind, name);
  }
  await defineType('note', NOTE_SCHEMA);
}

const createProcess = (process: string) =>
  environment.ok('create_process', { project: PROJECT, process });

const registerBatch = (process: string, records: Record<string, unknown>[]) =>
  environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: 'test-engineer',
    records,
  });

const registerOne = async (process: string, record: Record<string, unknown>) =>
  at((await registerBatch(process, [record])).records, 0).id;

const gapRecord = () => ({
  type: 'gap',
  target: 'unit-1.gap.retry',
  data: { question: 'Which retry policy applies?', context: 'No rule covers it' },
});

const premiseRecord = (gapId: string) => ({
  type: 'premise',
  target: 'unit-1.premise.retry',
  data: { statement: 'Retry three times with backoff' },
  relations: [{ to: gapId, as: 'fills-gap' }],
});

const revoke = (process: string, id: string) =>
  registerOne(process, {
    type: 'note',
    target: `${process}.note.revoker`,
    data: { text: 'revokes the answer' },
    relations: [{ to: id, kind: 'revokes' }],
  });

const recordOf = async (process: string, id: string) =>
  at(
    (await environment.ok<QueryResult>('query', { project: PROJECT, process, ids: [id] })).records,
    0,
  );

const gapsPassed = async (process = 'unit-1') =>
  (
    await environment.ok<GateEvaluation>('evaluate_gate', {
      project: PROJECT,
      process,
      gate: 'gaps',
    })
  ).passed;

/** Lacuna respondida em `unit-1`, com a evidência e o aval ligados à resposta e um dependente com `supports` cru. */
async function reviewedAnswer() {
  const gap = await registerOne('unit-1', gapRecord());
  const answer = await registerOne('unit-1', premiseRecord(gap));
  const { hash } = await environment.ok<{ hash: string }>('attach', {
    project: PROJECT,
    text: 'sources and reasoning',
  });
  const evidence = await registerOne('unit-1', {
    type: 'evidence',
    target: 'unit-1.evidence.retry',
    data: { summary: 'Backoff is the documented default', source: hash },
    relations: [{ to: answer, kind: 'supports' }],
  });
  const audit = await registerOne('unit-1', {
    type: 'audit',
    target: 'unit-1.audit.retry',
    data: { note: 'checked' },
    relations: [{ to: answer, as: 'audits' }],
  });
  const dependent = await registerOne('unit-1', {
    type: 'note',
    target: 'unit-1.note.dependent',
    data: { text: 'relies on the retry answer' },
    relations: [{ to: answer, kind: 'supports' }],
  });
  return { gap, answer, evidence, audit, dependent };
}

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('types', PACKAGE_DIR))('should accept the package type %s', async (name) => {
    const defined = await definePackageFile('types', name);

    expect(defined).toMatchObject({ name, created: true });
  });

  it.each(namesIn('types', PACKAGE_DIR))(
    'should replay the package type %s as unchanged',
    async (name) => {
      await definePackageFile('types', name);

      const replayed = await definePackageFile('types', name);

      expect(replayed).toMatchObject({ name, created: false });
    },
  );

  it('should define the package premise as a compatible minor over a statement-only premise', async () => {
    await defineType('premise', STATEMENT_ONLY);

    const defined = await definePackageFile('types', 'premise');

    expect(defined).toMatchObject({ created: true, previousVersion: '1.0', version: '1.1' });
  });
});

describe('define_relation', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('relations', PACKAGE_DIR))(
    'should accept the package relation %s',
    async (name) => {
      await definePackageFile('types', 'gap');
      await definePackageFile('types', 'premise');
      await definePackageFile('types', 'audit');

      const defined = await definePackageFile('relations', name);

      expect(defined).toMatchObject({ name, created: true });
    },
  );

  it.each(namesIn('relations', PACKAGE_DIR))(
    'should replay the package relation %s as unchanged',
    async (name) => {
      await definePackage();

      const replayed = await definePackageFile('relations', name);

      expect(replayed).toMatchObject({ name, created: false });
    },
  );
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it.each(namesIn('gates', PACKAGE_DIR))('should accept the package gate %s', async (name) => {
    await definePackageFile('types', 'gap');
    await definePackageFile('types', 'premise');
    await definePackageFile('relations', 'fills-gap');

    const defined = await definePackageFile('gates', name);

    expect(defined).toMatchObject({ name, created: true });
  });

  it.each(namesIn('gates', PACKAGE_DIR))(
    'should replay the package gate %s as unchanged',
    async (name) => {
      await definePackage();

      const replayed = await definePackageFile('gates', name);

      expect(replayed).toMatchObject({ name, created: false });
    },
  );
});

describe('describe_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should show the optional fields of the package premise', async () => {
    await definePackageFile('types', 'premise');

    const described = await environment.ok<DescribeTypeResult>('describe_type', {
      project: PROJECT,
      type: 'premise',
    });

    expect(Object.keys(described.schema.properties ?? {}).sort()).toEqual(
      ['actionUsed', 'answeredBy', 'basis', 'criteria', 'rule', 'statement'].sort(),
    );
  });
});

describe('evaluate_gate', () => {
  beforeEach(async () => {
    await openEnvironment();
    await definePackage();
    await createProcess('unit-1');
  });
  afterEach(closeEnvironment);

  describe('with the gaps gate', () => {
    it('should fail while a gap is open', async () => {
      await registerOne('unit-1', gapRecord());

      expect(await gapsPassed()).toBe(false);
    });

    it('should pass once a premise fills the gap', async () => {
      const gap = await registerOne('unit-1', gapRecord());
      await registerOne('unit-1', premiseRecord(gap));

      expect(await gapsPassed()).toBe(true);
    });

    it('should fail again when the premise that filled the gap is revoked', async () => {
      const gap = await registerOne('unit-1', gapRecord());
      const answer = await registerOne('unit-1', premiseRecord(gap));
      await revoke('unit-1', answer);

      expect(await gapsPassed()).toBe(false);
    });
  });
});

describe('query', () => {
  beforeEach(async () => {
    await openEnvironment();
    await definePackage();
    await createProcess('unit-1');
  });
  afterEach(closeEnvironment);

  it('should keep the audit that audits the answer as current', async () => {
    const { audit } = await reviewedAnswer();

    const page = await environment.ok<QueryResult>('query', {
      project: PROJECT,
      process: 'unit-1',
      type: 'audit',
    });

    expect(page.records.map(({ id }) => id)).toEqual([audit]);
  });

  describe('with the answer revoked', () => {
    it.each(['audit', 'evidence', 'dependent'] as const)(
      'should flag the %s of the answer with staleOut',
      async (kind) => {
        const ids = await reviewedAnswer();
        await revoke('unit-1', ids.answer);

        const flagged = await recordOf('unit-1', ids[kind]);

        expect(flagged.needsReview).toEqual({ staleIn: [], staleOut: [ids.answer] });
      },
    );
  });

  it('should flag the answer with staleIn when its audit is revoked', async () => {
    const { answer, audit } = await reviewedAnswer();
    await revoke('unit-1', audit);

    const flagged = await recordOf('unit-1', answer);

    expect(flagged.needsReview).toEqual({ staleIn: [audit], staleOut: [] });
  });

  describe('with a dependent superseded by a new version', () => {
    const supersede = (dependent: string, relations: Record<string, unknown>[]) =>
      registerOne('unit-1', {
        type: 'note',
        target: 'unit-1.note.dependent',
        data: { text: 'relies on the retry answer, revised' },
        relations: [{ to: dependent, kind: 'supersedes' }, ...relations],
      });

    it('should not flag the new version that did not rewrite the supports', async () => {
      const { answer, dependent } = await reviewedAnswer();
      const revised = await supersede(dependent, []);
      await revoke('unit-1', answer);

      const flagged = await recordOf('unit-1', revised);

      expect(flagged.needsReview).toBeUndefined();
    });

    it('should flag the new version that rewrote the supports', async () => {
      const { answer, dependent } = await reviewedAnswer();
      const revised = await supersede(dependent, [{ to: answer, kind: 'supports' }]);
      await revoke('unit-1', answer);

      const flagged = await recordOf('unit-1', revised);

      expect(flagged.needsReview).toEqual({ staleIn: [], staleOut: [answer] });
    });
  });
});

describe('register', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should refuse the basis field of a premise in a process created with a statement-only premise', async () => {
    await defineType('premise', STATEMENT_ONLY);
    await createProcess('old-unit');
    await definePackage();

    const error = await environment.fail(
      'register',
      {
        project: PROJECT,
        process: 'old-unit',
        agent: 'test-engineer',
        records: [
          {
            type: 'premise',
            target: 'old-unit.premise.a',
            data: { statement: 'Retry three times', basis: 'judgment' },
          },
        ],
      },
      'INVALID_RECORD',
    );

    expect(error.details).toContainEqual(
      expect.objectContaining({ path: '/records/0/data/basis' }),
    );
  });

  it('should refuse a premise in a process created before the package defined the type', async () => {
    await defineType('note', NOTE_SCHEMA);
    await createProcess('old-unit');
    await definePackage();

    const error = await environment.fail('register', {
      project: PROJECT,
      process: 'old-unit',
      agent: 'test-engineer',
      records: [
        {
          type: 'premise',
          target: 'old-unit.premise.a',
          data: { statement: 'Retry three times' },
        },
      ],
    });

    expect(error.code).toBe('TYPE_NOT_PINNED');
  });

  it('should refuse a revokes of the answer from a record of another process with cross-process-currency', async () => {
    await definePackage();
    await createProcess('unit-1');
    await createProcess('unit-1-2');
    const gap = await registerOne('unit-1', gapRecord());
    const answer = await registerOne('unit-1', premiseRecord(gap));

    const error = await environment.fail(
      'register',
      {
        project: PROJECT,
        process: 'unit-1-2',
        agent: 'test-engineer',
        records: [
          {
            type: 'note',
            target: 'unit-1-2.note.contest',
            data: { text: 'contests the answer' },
            relations: [{ to: answer, kind: 'revokes' }],
          },
        ],
      },
      'INVALID_RECORD',
    );

    expect(error.details).toMatchObject([
      { path: '/records/0/relations/0', code: 'cross-process-currency' },
    ]);
  });
});

describe('classifyTypeChange', () => {
  it('should classify the package properties added to a statement-only premise as compatible', () => {
    expect(classifyTypeChange(STATEMENT_ONLY, packageType('premise'))).toBe('compatible');
  });

  it('should classify a same-name property with a smaller maxLength in the package as breaking', () => {
    expect(classifyTypeChange(statementOnly(500), packageType('premise'))).toBe('breaking');
  });

  it('should classify a premise whose enum is narrower than the package enum as compatible', () => {
    const narrower: RecordType = {
      ...STATEMENT_ONLY,
      properties: {
        statement: { type: 'string', minLength: 1, maxLength: 255 },
        answeredBy: { type: 'string', enum: ['human'] },
      },
    };

    expect(classifyTypeChange(narrower, packageType('premise'))).toBe('compatible');
  });
});

describe('skills/hexlog-setup/references/owner-seat/types', () => {
  it('should require only statement, question, context, summary and source', () => {
    const required = namesIn('types', PACKAGE_DIR).flatMap(
      (name) => packageType(name).required ?? [],
    );

    expect(required.sort()).toEqual(['context', 'question', 'source', 'statement', 'summary']);
  });
});
