import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { slugOf } from '../scripts/flow/marker.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import type { Defined } from '../src/commands/definition.ts';
import { Name } from '../src/domain/ids.ts';
import type { GateEvaluation } from '../src/queries/query-service.ts';
import { at, listFiles } from './helpers.ts';
import { createEnvironment, type Environment } from './mcp/environment.ts';

const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'skills');
const referencesDir = path.join(skillsDir, 'hexlog-setup', 'references');

// Objetos soltos: o caso das chaves precisa ver a chave extra, que `z.object` descartaria.
const ModelSchema = z.looseObject({
  schema: z.literal(1),
  project: z.string(),
  unit: z.looseObject({
    kind: z.string(),
    location: z.string(),
    examples: z.array(z.looseObject({ path: z.string(), process: z.string() })),
  }),
  phases: z.array(
    z.looseObject({
      name: z.string(),
      command: z.string(),
      type: z.string(),
      target: z.string(),
      artifact: z.string(),
      links: z.array(z.looseObject({ relation: z.string(), to: z.string() })),
    }),
  ),
  types: z.array(
    z.looseObject({
      name: z.string(),
      schema: z.looseObject({
        properties: z
          .record(
            z.string(),
            z.looseObject({
              format: z.string().optional(),
              items: z.looseObject({ format: z.string().optional() }).optional(),
              maxLength: z.number().optional(),
            }),
          )
          .optional(),
        required: z.array(z.string()).optional(),
      }),
    }),
  ),
  relations: z.array(
    z.looseObject({
      name: z.string(),
      kind: z.string(),
      from: z.array(z.string()),
      to: z.array(z.string()),
    }),
  ),
  gate: z.looseObject({
    name: z.string(),
    questions: z.array(
      z.looseObject({ kind: z.string(), select: z.looseObject({ type: z.string() }).optional() }),
    ),
  }),
});

type Model = z.infer<typeof ModelSchema>;

const SKILL_NAME_MAX = 64;
const SKILL_SUFFIX = '-hexlog';
const SKILL_BASE_MAX = SKILL_NAME_MAX - SKILL_SUFFIX.length;

/** A regra da seção "Nome da skill do projeto" de `model-schema.md`. */
const skillNameOf = (project: string) =>
  `${project.replace(/-{2,}/g, '-').slice(0, SKILL_BASE_MAX).replace(/-+$/, '')}${SKILL_SUFFIX}`;

const sortedKeys = (value: object) => Object.keys(value).sort();

const exampleFiles = fs
  .readdirSync(referencesDir)
  .filter((file) => file.endsWith('.example.json'))
  .sort();

const readModel = (file: string): Model =>
  ModelSchema.parse(JSON.parse(fs.readFileSync(path.join(referencesDir, file), 'utf8')));

const threePhase = () => readModel('three-phase-model.example.json');
const minimal = () => readModel('minimal-model.example.json');

// Getter: o JSON só é lido dentro do caso, então um exemplo inválido reprova os casos dele sem
// derrubar a coleta da suíte.
const EXAMPLES = exampleFiles.map((file) => ({
  file,
  get model() {
    return readModel(file);
  },
}));

/** Linhas da tabela da seção `heading` de `model-schema.md`, sem o cabeçalho. */
const documentedRows = (heading: string) =>
  (
    fs
      .readFileSync(path.join(referencesDir, 'model-schema.md'), 'utf8')
      .split(/^## /m)
      .find((part) => part.startsWith(heading)) ?? ''
  )
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2);

const fieldOf = (row: string) => /^\|\s*`([^`]+)`/.exec(row)?.[1] ?? '';

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
  it.each(EXAMPLES)('should carry the keys model-schema.md documents in $file', ({ model }) => {
    const topRows = documentedRows('Campos de topo');
    const optional = topRows.filter((row) => row.includes('opcional')).map(fieldOf);
    const required = topRows.filter((row) => !row.includes('opcional')).map(fieldOf);
    const phaseRows = documentedRows('`phases[]`');
    const linkRow = at(
      phaseRows.filter((row) => fieldOf(row) === 'links'),
      0,
    );
    const linkKeys = (/`\{ (.+?) \}`/.exec(linkRow)?.[1] ?? '').split(', ').sort();
    const links = model.phases.flatMap((phase) => phase.links);

    expect(
      Object.keys(model)
        .filter((key) => !optional.includes(key))
        .sort(),
    ).toEqual(required.sort());
    expect(sortedKeys(model.unit)).toEqual(documentedRows('`unit`').map(fieldOf).sort());
    expect(model.phases.map(sortedKeys)).toEqual(
      model.phases.map(() => phaseRows.map(fieldOf).sort()),
    );
    expect(links.map(sortedKeys)).toEqual(links.map(() => linkKeys));
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
        links.map(({ to }) => ({
          kind: 'no_pending',
          pending: { type: to },
          resolvedBy: { kind: 'derivesFrom', from: [type] },
        })),
      );

      expect(model.gate.questions).toEqual(expect.arrayContaining(expected));
    },
  );

  it.each(EXAMPLES)('should link every phase by a derivesFrom relation in $file', ({ model }) => {
    const kinds = model.phases
      .flatMap((phase) => phase.links)
      .map(
        ({ relation }) =>
          model.relations.find(({ name }) => name === relation)?.kind ?? `unknown ${relation}`,
      );

    expect(kinds.filter((kind) => kind !== 'derivesFrom')).toEqual([]);
  });

  it.each(EXAMPLES)('should require a unit of at most 200 in every phase of $file', ({ model }) => {
    const unitFields = model.phases.map(({ type }) => {
      const schema = model.types.find(({ name }) => name === type)?.schema;
      return {
        required: schema?.required?.includes('unit'),
        max: schema?.properties?.unit?.maxLength,
      };
    });

    expect(unitFields).toEqual(model.phases.map(() => ({ required: true, max: 200 })));
  });

  it.each(EXAMPLES)('should declare what every phase and link names in $file', ({ model }) => {
    const typeNames = model.types.map(({ name }) => name);
    const relationNames = model.relations.map(({ name }) => name);
    const phaseTypes = model.phases.map(({ type }) => type);
    const links = model.phases.flatMap((phase) => phase.links);

    expect(phaseTypes.filter((type) => !typeNames.includes(type))).toEqual([]);
    expect(
      links.map(({ relation }) => relation).filter((relation) => !relationNames.includes(relation)),
    ).toEqual([]);
    expect(links.map(({ to }) => to).filter((to) => !phaseTypes.includes(to))).toEqual([]);
  });

  it.each(EXAMPLES)('should keep the rendered values on one line in $file', ({ model }) => {
    const values = [
      model.unit.kind,
      model.unit.location,
      ...model.phases.flatMap(({ command, artifact }) => [command, artifact]),
    ];

    expect(values.filter((value) => /["\\\n]/.test(value))).toEqual([]);
  });

  it.each(EXAMPLES)('should derive every process name from the unit path in $file', ({ model }) => {
    const { examples } = model.unit;

    expect(examples.map((example) => slugOf(example.path))).toEqual(
      examples.map((example) => example.process),
    );
  });

  it.each(EXAMPLES)('should fit the project skill name within the limit in $file', ({ model }) => {
    const name = skillNameOf(model.project);

    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(SKILL_NAME_MAX);
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

  it('should accept every type of the three-phase example', async () => {
    const model = threePhase();

    const results = await defineTypes(model);

    expect(results.map(({ name, created }) => ({ name, created }))).toEqual(
      model.types.map(({ name }) => ({ name, created: true })),
    );
  });
});

describe('define_relation', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept every relation of the three-phase example', async () => {
    const model = threePhase();
    await defineTypes(model);

    const results = await defineRelations(model);

    expect(results.map(({ name, created }) => ({ name, created }))).toEqual(
      model.relations.map(({ name }) => ({ name, created: true })),
    );
  });
});

describe('define_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should accept the gate of the three-phase example', async () => {
    const model = threePhase();

    const result = await defineGate(model);

    expect(result).toMatchObject({ name: model.gate.name, created: true });
  });
});

describe('evaluate_gate', () => {
  beforeEach(openEnvironment);
  afterEach(closeEnvironment);

  it('should pass the gate when build derives from design and check from build', async () => {
    const model = threePhase();
    await setUp(model);
    await registerPhases(model);

    const result = await evaluate(model);

    expect(result.passed).toBe(true);
  });

  it('should fail the gate when check is not linked to build', async () => {
    const model = threePhase();
    await setUp(model);
    const { records } = await registerPhases(model, 'check');
    const buildId = at(records, 1).id;

    const result = await evaluate(model, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({
        kind: 'no_pending',
        passed: false,
        evidence: expect.objectContaining({ unresolved: [buildId] }),
      }),
    );
  });

  it('should fail the gate when build is not linked to design', async () => {
    const model = threePhase();
    await setUp(model);
    const { records } = await registerPhases(model, 'build');
    const designId = at(records, 0).id;

    const result = await evaluate(model, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({
        kind: 'no_pending',
        passed: false,
        evidence: expect.objectContaining({ unresolved: [designId] }),
      }),
    );
  });

  it('should fail the gate when a phase has no record', async () => {
    const model = threePhase();
    await setUp(model);
    await registerPhases(model, undefined, 'check');

    const result = await evaluate(model, 'full');

    expect(result.passed).toBe(false);
    expect(result.questions).toContainEqual(
      expect.objectContaining({ kind: 'occurred', passed: false }),
    );
  });

  it('should accept the minimal example without any flow', async () => {
    const model = minimal();
    await setUp(model);
    await registerPhases(model);

    const result = await evaluate(model);

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

  it('should mention flow.md only in the hexlog-flow SKILL.md', () => {
    expect(Object.keys(occurrences(/flow\.md/g))).toEqual(['skills/hexlog-flow/SKILL.md']);
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

  it('should read the minimal example command right after "After"', () => {
    const commands = minimal()
      .phases.map(({ command }) => command)
      .join(', ');

    const block = lines.join('\n').replace('{{commands}}', commands);

    expect(block).toContain('After running the review checklist, you MUST');
  });
});

const ruleKeys = (text: string) =>
  [...text.matchAll(/^- \*\*([^*]+)\*\*:/gm)].map(([, key]) => key ?? '');

describe('skills/hexlog-setup/references/owner-seat*.template.md', () => {
  const templates = readDocuments(
    fs
      .readdirSync(referencesDir)
      .filter((file) => /^owner-seat.*\.template\.md$/.test(file))
      .sort()
      .map((file) => path.join(referencesDir, file)),
  );
  const recipes = templates.filter(({ file }) => file.includes('owner-seat-recipe-'));
  const criteria = at(
    templates.filter(({ file }) => file.endsWith('owner-seat-criteria.template.md')),
    0,
  ).content;

  it('should not mention the development flow tooling', () => {
    expect(occurrencesIn(templates, /\bOMC\b|herdr|scripts\/flow|critic|\.omc/gi)).toEqual({});
  });

  it.each(recipes)('should not declare a Status line in $file', ({ content }) => {
    expect(content).not.toMatch(/^Status:/m);
  });

  it.each(recipes)(
    'should not carry a fallback that swaps --restricted in $file',
    ({ content }) => {
      expect(content).not.toMatch(/--setting-sources/);
    },
  );

  it('should end the criteria template with the Rules heading', () => {
    const headings = criteria.match(/^#{1,6} .*$/gm) ?? [];

    expect(headings.at(-1)).toBe('## Rules');
  });

  it('should ship the criteria template without rule bullets', () => {
    expect(ruleKeys(criteria)).toEqual([]);
  });

  it('should state the 120 character limit of the rule key in the criteria template', () => {
    expect(criteria).toMatch(/at most 120 characters/);
  });

  describe('with the contract template', () => {
    const contract = at(
      templates.filter(({ file }) => file.endsWith('owner-seat-contract.template.md')),
      0,
    ).content;
    const scope = /^## Scope\n([\s\S]*?)(?=^## )/m.exec(contract)?.[1] ?? '';

    it('should carry a Scope section that forbids the writes outside the answer', () => {
      expect(scope).toMatch(/`revokes`.*`supersedes`.*`create_process`.*`define_\*`/s);
    });

    it('should state that the Scope is an instruction and not a barrier', () => {
      expect(scope).toMatch(/instruction, not a barrier/);
    });
  });
});

describe('skills/hexlog-setup/references/project-skill.template.md', () => {
  const content = fs.readFileSync(path.join(referencesDir, 'project-skill.template.md'), 'utf8');

  it('should name the skill by the skill_name placeholder', () => {
    expect(content).toMatch(/^name: \{\{skill_name\}\}$/m);
  });

  it('should ask the developer for an ok before the agy recipe runs', () => {
    expect(content).toMatch(/`recipe-agy\.md`.*wait for the developer's ok/s);
  });
});

describe('skills/hexlog-setup/references/model-schema.md', () => {
  const content = fs.readFileSync(path.join(referencesDir, 'model-schema.md'), 'utf8');
  const section = content.split(/^## /m).find((part) => part.startsWith('`ownerSeat`')) ?? '';
  const rows = section.split('\n').filter((line) => line.startsWith('|'));
  const fields = rows.slice(2).map((row) => /^\|\s*`([^`]+)`/.exec(row)?.[1] ?? '');

  it('should document at least one ownerSeat field', () => {
    expect(fields.length).toBeGreaterThan(0);
  });

  it('should not document an ownerSeat field that holds a path', () => {
    expect(fields.filter((field) => /path|dir|file|location|checkout/i.test(field))).toEqual([]);
  });

  it('should not put an absolute, tilde or HOME path in the ownerSeat table', () => {
    expect(rows.join('\n')).not.toMatch(/~|\$HOME|`\/[^`]+`/);
  });
});

describe('docs/setup-aceitacao.md', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'docs', 'setup-aceitacao.md'), 'utf8');
  const checklist = content.split(/^## /m).find((part) => part.startsWith('Checklist')) ?? '';
  const sections = checklist.split(/^### /m).slice(1);

  it('should have at least one checklist item in every checklist section', () => {
    expect(sections.length).toBeGreaterThan(0);

    const withoutItems = sections.filter((section) => !/^- \[ \]/m.test(section));

    expect(withoutItems).toEqual([]);
  });
});

describe('skills/hexlog-setup/references/interview-guide.md', () => {
  it('should ask for a project name that leaves room for the skill suffix', () => {
    const content = fs.readFileSync(path.join(referencesDir, 'interview-guide.md'), 'utf8');

    expect(content).toContain(`up to ${SKILL_BASE_MAX} characters`);
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
