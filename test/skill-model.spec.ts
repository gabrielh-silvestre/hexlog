import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegisterResult } from '../src/commands/process.ts';
import type { Defined } from '../src/commands/definition.ts';
import { Name } from '../src/domain/ids.ts';
import type { GateEvaluation } from '../src/queries/query-service.ts';
import { at, listFiles } from './helpers.ts';
import { createEnvironment, type Environment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'skills');
const referencesDir = path.join(skillsDir, 'hexlog-setup', 'references');

type Schema = {
  properties?: Record<string, { format?: string; items?: { format?: string }; maxLength?: number }>;
  required?: string[];
};

type Model = {
  project: string;
  unit: { examples: { path: string; process: string }[] };
  phases: {
    name: string;
    type: string;
    target: string;
    links: { relation: string; to: string }[];
  }[];
  types: { name: string; schema: Schema }[];
  relations: { name: string; kind: string; from: string[]; to: string[] }[];
  gate: { name: string; questions: object[] };
};

// Chaves de topo documentadas em `model-schema.md`: as obrigatórias e a única opcional.
const REQUIRED_MODEL_KEYS = [
  'schema',
  'modelVersion',
  'project',
  'language',
  'unit',
  'phases',
  'types',
  'relations',
  'gate',
  'plug',
];
const OPTIONAL_MODEL_KEYS = ['targetPattern'];

const exampleFiles = fs
  .readdirSync(referencesDir)
  .filter((file) => file.endsWith('.example.json'))
  .sort();

const readModel = (file: string): Model =>
  JSON.parse(fs.readFileSync(path.join(referencesDir, file), 'utf8')) as Model;

const SPECKIT = readModel('speckit-model.example.json');
const MINIMAL = readModel('minimal-model.example.json');

const EXAMPLES = exampleFiles.map((file) => ({ file, model: readModel(file) }));
const PHASE_TYPES = EXAMPLES.flatMap(({ file, model }) =>
  model.phases.map(({ type }) => ({
    label: `${file}#${type}`,
    schema: at(
      model.types.filter(({ name }) => name === type),
      0,
    ).schema,
  })),
);

let environment: Environment;

const openEnvironment = async () => {
  environment = await createEnvironment();
};
const closeEnvironment = async () => {
  await environment.close();
};

const defineTypes = (model: Model) =>
  Promise.all(
    model.types.map(({ name, schema }) =>
      environment.ok<Defined>('define_type', { project: model.project, name, schema }),
    ),
  );

const defineRelations = (model: Model) =>
  Promise.all(
    model.relations.map((relation) =>
      environment.ok<Defined>('define_relation', { project: model.project, ...relation }),
    ),
  );

const defineGate = (model: Model) =>
  environment.ok<Defined>('define_gate', { project: model.project, ...model.gate });

const processOf = (model: Model) => at(model.unit.examples, 0).process;

/** Define tudo o que o modelo declara e cria o processo da primeira unidade de exemplo. */
async function setUp(model: Model) {
  await defineTypes(model);
  await defineRelations(model);
  await defineGate(model);
  await environment.ok('create_process', { project: model.project, process: processOf(model) });
}

/**
 * Registra um registro por fase, ligados pelas relações do modelo; `skipLinksOf` deixa de fora as
 * relações da fase nomeada.
 */
function registerPhases(model: Model, skipLinksOf?: string) {
  return environment.ok<RegisterResult>('register', {
    project: model.project,
    process: processOf(model),
    agent: 'test-engineer',
    records: model.phases.map(({ name, type, target, links }) => ({
      alias: name,
      type,
      target,
      data: { unit: at(model.unit.examples, 0).path, summary: `the ${name} phase` },
      relations:
        name === skipLinksOf
          ? []
          : links.map(({ relation, to }) => ({
              to: `@${
                at(
                  model.phases.filter((phase) => phase.type === to),
                  0,
                ).name
              }`,
              as: relation,
            })),
    })),
  });
}

const evaluate = (model: Model, evidence: 'full' | 'counts' = 'counts') =>
  environment.ok<GateEvaluation>('evaluate_gate', {
    project: model.project,
    process: processOf(model),
    gate: model.gate.name,
    evidence,
  });

const relativeToRepo = (file: string) => path.relative(repoRoot, file);

describe('skills/hexlog-setup/references/*.example.json', () => {
  it.each(EXAMPLES)('should carry the documented top-level keys in $file', ({ model }) => {
    const required = Object.keys(model).filter((key) => !OPTIONAL_MODEL_KEYS.includes(key));

    expect(required.sort()).toEqual([...REQUIRED_MODEL_KEYS].sort());
  });

  it.each(PHASE_TYPES)('should require a unit field with maxLength in $label', ({ schema }) => {
    expect(schema.required).toContain('unit');
    expect(schema.properties?.unit?.maxLength).toEqual(expect.any(Number));
  });

  it.each(EXAMPLES)('should not use pattern or patternProperties in $file', ({ model }) => {
    expect(JSON.stringify(model.types)).not.toMatch(/"pattern(Properties)?"\s*:/);
  });

  it.each(EXAMPLES)('should list valid and distinct process names in $file', ({ model }) => {
    const processes = model.unit.examples.map(({ process }) => process);

    expect(processes.every((process) => Name.safeParse(process).success)).toBe(true);
    expect(new Set(processes).size).toBe(processes.length);
  });

  it.each(EXAMPLES)(
    'should mark attachment fields only at the first level in $file',
    ({ model }) => {
      const total = JSON.stringify(model.types).match(/"format":"attachment"/g)?.length ?? 0;
      const firstLevel = model.types.reduce(
        (sum, { schema }) =>
          sum +
          Object.values(schema.properties ?? {}).filter(
            ({ format, items }) => format === 'attachment' || items?.format === 'attachment',
          ).length,
        0,
      );

      expect(firstLevel).toBe(total);
    },
  );
});

describe('define_type', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept every type of the Spec Kit example', async () => {
    const results = await defineTypes(SPECKIT);

    expect(results.map(({ name, created }) => ({ name, created }))).toEqual(
      SPECKIT.types.map(({ name }) => ({ name, created: true })),
    );
  });
});

describe('define_relation', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept every relation of the Spec Kit example', async () => {
    await defineTypes(SPECKIT);

    const results = await defineRelations(SPECKIT);

    expect(results.map(({ name, created }) => ({ name, created }))).toEqual(
      SPECKIT.relations.map(({ name }) => ({ name, created: true })),
    );
  });
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept the gate of the Spec Kit example', async () => {
    const result = await defineGate(SPECKIT);

    expect(result).toMatchObject({ name: SPECKIT.gate.name, created: true });
  });
});

describe('create_process', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should replay every define call and the process as unchanged', async () => {
    await setUp(SPECKIT);

    const replayed = [
      ...(await defineTypes(SPECKIT)),
      ...(await defineRelations(SPECKIT)),
      await defineGate(SPECKIT),
    ];
    const process = await environment.ok<{ created: boolean }>('create_process', {
      project: SPECKIT.project,
      process: processOf(SPECKIT),
    });

    expect(replayed.map(({ created }) => created)).not.toContain(true);
    expect(process.created).toBe(false);
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should pass the gate when plan derives from spec and tasks from plan', async () => {
    await setUp(SPECKIT);
    await registerPhases(SPECKIT);

    const result = await evaluate(SPECKIT);

    expect(result.passed).toBe(true);
  });

  it('should fail the gate when tasks is not linked to plan', async () => {
    await setUp(SPECKIT);
    const { records } = await registerPhases(SPECKIT, 'tasks');
    const planId = at(records, 1).id;

    const result = await evaluate(SPECKIT, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({
        kind: 'no_pending',
        passed: false,
        evidence: expect.objectContaining({ unresolved: [planId] }),
      }),
    );
  });

  it('should accept the minimal example without any flow', async () => {
    await setUp(MINIMAL);
    await registerPhases(MINIMAL);

    const result = await evaluate(MINIMAL);

    expect(result.passed).toBe(true);
  });
});

describe('skills/**/*.md', () => {
  const documents = listFiles(skillsDir, '.md').map((file) => ({
    file: relativeToRepo(file),
    content: fs.readFileSync(file, 'utf8'),
  }));

  /** Arquivos cujo conteúdo casa `pattern`, com a contagem de ocorrências de cada um. */
  const occurrences = (pattern: RegExp, scope = '') =>
    Object.fromEntries(
      documents
        .filter(({ file }) => file.startsWith(`skills/${scope}`))
        .map(({ file, content }) => [file, content.match(pattern)?.length ?? 0] as const)
        .filter(([, count]) => count > 0),
    );

  const body = (skill: string) => {
    const content = at(
      documents.filter(({ file }) => file === `skills/${skill}/SKILL.md`),
      0,
    ).content;
    return content.replace(/^---\n[\s\S]*?\n---\n/, '');
  };

  it('should not mention editedSkills', () => {
    expect(occurrences(/editedSkills/g)).toEqual({});
  });

  it('should not mention the old flow map term', () => {
    expect(occurrences(/flow map/gi)).toEqual({});
  });

  it('should not mention targetIdPattern', () => {
    expect(occurrences(/targetIdPattern/g)).toEqual({});
  });

  it('should mention flow.md once, in the hexlog-flow migration sentence', () => {
    expect(occurrences(/flow\.md/g)).toEqual({ 'skills/hexlog-flow/SKILL.md': 1 });
  });

  it('should not mention OMC in hexlog-setup', () => {
    expect(occurrences(/\bOMC\b/g, 'hexlog-setup/')).toEqual({});
  });

  it('should not carry a traps heading in hexlog-setup', () => {
    expect(occurrences(/^#+\s+Armadilhas/gm, 'hexlog-setup/')).toEqual({});
  });

  it('should keep the traps heading in hexlog', () => {
    expect(occurrences(/^#+\s+Armadilhas/gm, 'hexlog/')).toEqual({ 'skills/hexlog/SKILL.md': 1 });
  });

  it('should not tell the agent to write settings.json', () => {
    expect(occurrences(/settings\.json/g, 'hexlog-setup/')).toEqual({});
  });

  it('should check the project with list before the first define call in hexlog-setup', () => {
    const setup = body('hexlog-setup');

    const listAt = setup.search(/`list`/);
    const defineAt = setup.search(/`define_[^`]*`/);

    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(defineAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeLessThan(defineAt);
  });
});

describe('skills/hexlog-setup/references/plug-speckit.md', () => {
  const PROVEN_VERSIONS_HEADER = '| Versão | Evidência no hexlog | Fases que disparam |';
  const content = fs.readFileSync(path.join(referencesDir, 'plug-speckit.md'), 'utf8');
  const section = content
    .split(/^## /m)
    .find((part) => part.startsWith('Versões do Spec Kit provadas'));
  const tableLines = (section ?? '').split('\n').filter((line) => line.startsWith('|'));

  it('should keep the proven-versions table well formed', () => {
    const [header, , ...rows] = tableLines;
    const evidenceOf = (row: string) => row.split('|').map((cell) => cell.trim())[2];

    expect(section).toBeDefined();
    expect(header).toBe(PROVEN_VERSIONS_HEADER);
    expect(rows.every((row) => (evidenceOf(row) ?? '') !== '')).toBe(true);
  });
});
