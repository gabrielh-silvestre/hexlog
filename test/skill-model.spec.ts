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

type GateQuestion = {
  kind: string;
  select?: { type: string };
  pending?: { type: string };
  resolvedBy?: { kind: string; from: string[] };
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
  plug: { layer: string };
  types: { name: string; schema: Schema }[];
  relations: { name: string; kind: string; from: string[]; to: string[] }[];
  gate: { name: string; questions: GateQuestion[] };
};

// Chaves de topo documentadas em `model-schema.md`: as obrigatórias e a única opcional.
const REQUIRED_MODEL_KEYS = [
  'schema',
  'project',
  'unit',
  'phases',
  'types',
  'relations',
  'gate',
  'plug',
];
const OPTIONAL_MODEL_KEYS = ['targetPattern'];

// Chaves exatas dos objetos aninhados, como `model-schema.md` as documenta (sem opcionais).
const UNIT_KEYS = ['kind', 'location', 'examples'];
const PHASE_KEYS = ['name', 'command', 'type', 'target', 'artifact', 'links'];
const PLUG_KEYS = ['layer'];
const LINK_KEYS = ['relation', 'to'];
// Camadas do plug documentadas em `model-schema.md`.
const PLUG_LAYERS = ['C'];

const sortedKeys = (value: object) => Object.keys(value).sort();

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
 * relações da fase nomeada e `omit` deixa de fora a fase nomeada (só vale para fase sem sucessora).
 */
function registerPhases(model: Model, skipLinksOf?: string, omit?: string) {
  return environment.ok<RegisterResult>('register', {
    project: model.project,
    process: processOf(model),
    agent: 'test-engineer',
    records: model.phases
      .filter(({ name }) => name !== omit)
      .map(({ name, type, target, links }) => ({
        alias: name,
        type,
        target: `${processOf(model)}.${target}`,
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

const readDocuments = (files: string[]) =>
  files.map((file) => ({
    file: path.relative(repoRoot, file),
    content: fs.readFileSync(file, 'utf8'),
  }));

/** Arquivos de `documents` sob o prefixo `scope` cujo conteúdo casa `pattern`, com a contagem de cada um. */
const occurrencesIn = (documents: ReturnType<typeof readDocuments>, pattern: RegExp, scope = '') =>
  Object.fromEntries(
    documents
      .filter(({ file }) => file.startsWith(scope))
      .map(({ file, content }) => [file, content.match(pattern)?.length ?? 0] as const)
      .filter(([, count]) => count > 0),
  );

describe('skills/hexlog-setup/references/*.example.json', () => {
  it.each(EXAMPLES)('should carry the documented top-level keys in $file', ({ model }) => {
    const required = Object.keys(model).filter((key) => !OPTIONAL_MODEL_KEYS.includes(key));

    expect(required.sort()).toEqual([...REQUIRED_MODEL_KEYS].sort());
  });

  it.each(EXAMPLES)(
    'should ask the gate for an occurrence of every phase type in $file',
    ({ model }) => {
      const phaseTypes = model.phases.map(({ type }) => type);

      const questions = model.gate.questions.filter(({ kind }) => kind === 'occurred');

      expect(questions.map(({ select }) => select?.type)).toEqual(
        expect.arrayContaining(phaseTypes),
      );
    },
  );

  it.each(EXAMPLES)(
    'should ask the gate for a no_pending of every phase with a successor in $file',
    ({ model }) => {
      const expected = model.phases.flatMap(({ type, links }) =>
        links.map(({ relation, to }) => ({
          kind: 'no_pending',
          pending: { type: to },
          resolvedBy: {
            kind: at(
              model.relations.filter(({ name }) => name === relation),
              0,
            ).kind,
            from: [type],
          },
        })),
      );

      expect(model.gate.questions).toEqual(expect.arrayContaining(expected));
    },
  );

  it.each(PHASE_TYPES)('should require a unit field with maxLength in $label', ({ schema }) => {
    expect(schema.required).toContain('unit');
    expect(schema.properties?.unit?.maxLength).toEqual(expect.any(Number));
  });

  it.each(EXAMPLES)('should carry exactly the documented unit keys in $file', ({ model }) => {
    expect(sortedKeys(model.unit)).toEqual([...UNIT_KEYS].sort());
  });

  it.each(EXAMPLES)('should carry exactly the documented phase keys in $file', ({ model }) => {
    expect(model.phases.map(sortedKeys)).toEqual(model.phases.map(() => [...PHASE_KEYS].sort()));
  });

  it.each(EXAMPLES)('should carry exactly the documented plug keys in $file', ({ model }) => {
    expect(sortedKeys(model.plug)).toEqual([...PLUG_KEYS].sort());
  });

  it.each(EXAMPLES)('should carry exactly the documented link keys in $file', ({ model }) => {
    const links = model.phases.flatMap((phase) => phase.links);

    expect(links.map(sortedKeys)).toEqual(links.map(() => [...LINK_KEYS].sort()));
  });

  it.each(EXAMPLES)('should declare a type for every phase type in $file', ({ model }) => {
    const typeNames = model.types.map(({ name }) => name);

    expect(
      model.phases.map(({ type }) => type).filter((type) => !typeNames.includes(type)),
    ).toEqual([]);
  });

  it.each(EXAMPLES)('should declare a relation for every link in $file', ({ model }) => {
    const relationNames = model.relations.map(({ name }) => name);
    const links = model.phases.flatMap((phase) => phase.links);

    expect(
      links.map(({ relation }) => relation).filter((relation) => !relationNames.includes(relation)),
    ).toEqual([]);
  });

  it.each(EXAMPLES)('should point every link to a phase type in $file', ({ model }) => {
    const phaseTypes = model.phases.map(({ type }) => type);
    const links = model.phases.flatMap((phase) => phase.links);

    expect(links.map(({ to }) => to).filter((to) => !phaseTypes.includes(to))).toEqual([]);
  });

  it.each(EXAMPLES)('should use a documented plug layer in $file', ({ model }) => {
    expect(PLUG_LAYERS).toContain(model.plug.layer);
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

  it('should replay every type of the Spec Kit example as unchanged', async () => {
    await setUp(SPECKIT);

    const results = await defineTypes(SPECKIT);

    expect(results.map(({ created }) => created)).toEqual(SPECKIT.types.map(() => false));
  });

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

  it('should replay every relation of the Spec Kit example as unchanged', async () => {
    await setUp(SPECKIT);

    const results = await defineRelations(SPECKIT);

    expect(results.map(({ created }) => created)).toEqual(SPECKIT.relations.map(() => false));
  });

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

  it('should replay the gate of the Spec Kit example as unchanged', async () => {
    await setUp(SPECKIT);

    const result = await defineGate(SPECKIT);

    expect(result.created).toBe(false);
  });

  it('should accept the gate of the Spec Kit example', async () => {
    const result = await defineGate(SPECKIT);

    expect(result).toMatchObject({ name: SPECKIT.gate.name, created: true });
  });
});

describe('create_process', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should replay the process as unchanged', async () => {
    await setUp(SPECKIT);

    const result = await environment.ok<{ created: boolean }>('create_process', {
      project: SPECKIT.project,
      process: processOf(SPECKIT),
    });

    expect(result.created).toBe(false);
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

  it('should fail the gate when plan is not linked to spec', async () => {
    await setUp(SPECKIT);
    const { records } = await registerPhases(SPECKIT, 'plan');
    const specId = at(records, 0).id;

    const result = await evaluate(SPECKIT, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({
        kind: 'no_pending',
        passed: false,
        evidence: expect.objectContaining({ unresolved: [specId] }),
      }),
    );
  });

  it('should fail the gate when a phase has no record', async () => {
    await setUp(SPECKIT);
    await registerPhases(SPECKIT, undefined, 'tasks');

    const result = await evaluate(SPECKIT, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({ kind: 'occurred', passed: false }),
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
  const documents = readDocuments(listFiles(skillsDir, '.md'));

  const occurrences = (pattern: RegExp, scope = '') =>
    occurrencesIn(documents, pattern, `skills/${scope}`);

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
    const row =
      body('hexlog-setup')
        .split('\n')
        .find((line) => /^\|\s*\d+\s*\|\s*Projeto hexlog\s*\|/.test(line)) ?? '';

    const listAt = row.search(/`list`/);
    const defineAt = row.search(/`define_[^`]*`/);

    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(defineAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeLessThan(defineAt);
  });
});

describe('skills/hexlog-setup/references/agents-block.template.md', () => {
  const content = fs.readFileSync(path.join(referencesDir, 'agents-block.template.md'), 'utf8');
  const lines = (/```markdown\n([\s\S]*?)\n```/.exec(content)?.[1] ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');

  it('should open the block with the exact hexlog heading', () => {
    expect(lines[0]).toBe('## hexlog');
  });

  it('should keep the block between 1 and 8 non-empty lines', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(8);
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

describe('docs/setup-aceitacao.md', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'docs', 'setup-aceitacao.md'), 'utf8');
  // Rótulos de trabalho que não valem no repositório; a lista é conservadora.
  const PLAN_LABEL = /\b(?:D[1-6](?:-\d+)?|A1|AC\d*|PR-[12])\b/;
  const checklist = content.split(/^## /m).find((part) => part.startsWith('Checklist')) ?? '';
  const sections = checklist.split(/^### /m).slice(1);

  it('should have at least one checklist item in every checklist section', () => {
    expect(sections.length).toBeGreaterThan(0);

    const withoutItems = sections.filter((section) => !/^- \[ \]/m.test(section));

    expect(withoutItems).toEqual([]);
  });

  it('should not carry plan labels', () => {
    expect(content).not.toMatch(PLAN_LABEL);
  });
});

describe('docs/instalacao.md', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'docs', 'instalacao.md'), 'utf8');
  const requirements = content.split(/^## /m).find((part) => part.startsWith('Requisitos')) ?? '';

  it('should state the checkout requirement in the requirements section', () => {
    expect(requirements).toContain('checkout');
    expect(requirements).toContain('npm ci');
  });
});

describe('README.md, docs/**/*.md and AGENTS.md', () => {
  const files = [
    path.join(repoRoot, 'README.md'),
    path.join(repoRoot, 'AGENTS.md'),
    ...listFiles(path.join(repoRoot, 'docs'), '.md'),
  ];
  // `pesquisa/` é congelada e o ADR 0013 documenta a aposentadoria dos termos.
  const documents = readDocuments(files).filter(
    ({ file }) =>
      !file.startsWith('docs/pesquisa/') && !file.startsWith('docs/directives/adr-0013-'),
  );

  it('should not mention the retired setup terms', () => {
    expect(occurrencesIn(documents, /flow\.md|flow map|editedSkills|targetIdPattern/gi)).toEqual(
      {},
    );
  });
});
