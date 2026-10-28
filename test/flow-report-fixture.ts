import { omit } from 'es-toolkit';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processPaths } from '../src/adapters/fs/data-format.ts';
import type { RegisterResult } from '../src/commands/process.ts';
import { BATCH_MAX } from '../src/domain/record.ts';
import type { QueryResult } from '../src/queries/query-service.ts';
import { defineFlowDefinitions, definitionOf, type FlowRecord } from './flow-data.ts';
import { at, copyToXdg, createTempDir } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';

const PROJECT = 'hexlog';
const AGENT = 'flow-report-spec';

type Item = FlowRecord & { alias?: string };
type Relations = Record<string, unknown>[];

const lookup =
  <T>(map: Record<string, T>, what: string) =>
  (name: string): T => {
    const value = map[name];
    if (value === undefined) throw new Error(`no ${what} "${name}"`);
    return value;
  };

const rests = (to: string) => ({ kind: 'derivesFrom', as: 'rests-on', to });
const anchoredIn = (to: string) => ({ kind: 'derivesFrom', as: 'anchored-in', to });
const fillsGap = (to: string) => ({ kind: 'answers', as: 'fills-gap', to });

const premise = (
  proc: string,
  short: string,
  extra: { answeredBy?: string; relations?: Relations } = {},
): Item => ({
  type: 'premise',
  target: `${proc}.premise.${short}`,
  data: {
    statement: `Premise ${short}`,
    ...(extra.answeredBy === undefined ? {} : { answeredBy: extra.answeredBy }),
  },
  ...(extra.relations === undefined ? {} : { relations: extra.relations }),
});

/** `targetShort` troca o target do registro, para quem substitui o anterior (`supersedes` exige o mesmo target). */
const gapOf = (
  proc: string,
  short: string,
  context: string,
  relations: Relations = [],
  targetShort = short,
): Item => ({
  type: 'gap',
  target: `${proc}.gap.${targetShort}`,
  data: { question: `Question ${short}`, context },
  relations,
});

const criticalGap = (proc: string, short: string, rule: string): Item =>
  gapOf(proc, short, `Class: critical; rule: ${rule}`);

/** `targetShort` troca o target do registro, para quem substitui o anterior (`supersedes` exige o mesmo target). */
const decision = (
  proc: string,
  short: string,
  relations: Relations,
  targetShort = short,
): Item => ({
  type: 'decision',
  target: `${proc}.decision.${targetShort}`,
  data: {
    choice: `Choice ${short}`,
    alternatives: [{ option: 'Other', reason: 'Not needed' }],
    rationale: 'Because',
    grounds: 'directive',
    confidence: 'high',
  },
  relations,
});

/** `premise` como era antes do campo `answeredBy`: o processo que a fixa assim não o tem. */
const premiseWithoutAnsweredBy = (): Record<string, unknown> => {
  const { properties, ...rest } = definitionOf('types', 'premise');
  return { ...rest, properties: omit(properties as Record<string, unknown>, ['answeredBy']) };
};

/** Grava `items` em lotes de até `BATCH_MAX` e devolve os ids na ordem. */
async function registerItems(
  environment: Environment,
  proc: string,
  items: Item[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < items.length; start += BATCH_MAX) {
    const { records } = await environment.ok<RegisterResult>('register', {
      project: PROJECT,
      process: proc,
      agent: AGENT,
      records: items.slice(start, start + BATCH_MAX),
    });
    ids.push(...records.map((record) => record.id));
  }
  return ids;
}

/** Um lote só: a chave de cada item é o alias que as relações do lote citam como `@chave`. */
async function registerNamed(
  environment: Environment,
  proc: string,
  items: Record<string, Item>,
): Promise<Record<string, string>> {
  const entries = Object.entries(items);
  const ids = await registerItems(
    environment,
    proc,
    entries.map(([alias, item]) => ({ ...item, alias })),
  );
  return Object.fromEntries(entries.map(([name], index) => [name, at(ids, index)]));
}

/** Objetivo, `premises` premissas `p00`, `p01`... e `decisions` decisões `d0`... que citam só o objetivo. */
async function registerObjectiveFixture(
  environment: Environment,
  proc: string,
  { premises, decisions }: { premises: number; decisions: number },
): Promise<void> {
  const shorts = Array.from({ length: premises }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const ids = await registerItems(environment, proc, [
    premise(proc, 'objective'),
    ...shorts.map((short) => premise(proc, short)),
  ]);
  const objective = at(ids, 0);
  await registerItems(
    environment,
    proc,
    Array.from({ length: decisions }, (_, index) =>
      decision(proc, `d${index}`, [rests(objective)]),
    ),
  );
}

function gitWithEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const git = (cwd: string, ...args: string[]): string => gitWithEnv(cwd, {}, ...args);

/**
 * main com dois docs; `feat/r` altera só `convencoes.md` (commit em 2099) e `invariantes.md` (em 2000);
 * a base `origin/develop` é criada à mão e avança com `fluxo-hexlog.md` depois de `feat/r` sair.
 */
function createGitRepo(): string {
  const gitRepo = createTempDir('flow-report-git');
  git(gitRepo, 'init', '-q', '-b', 'main');
  git(gitRepo, 'config', 'user.email', 'test@example.com');
  git(gitRepo, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(gitRepo, 'docs/directives'), { recursive: true });
  for (const doc of ['convencoes', 'fluxo-hexlog', 'invariantes']) {
    fs.writeFileSync(path.join(gitRepo, `docs/directives/${doc}.md`), `# ${doc}\n`);
  }
  git(gitRepo, 'add', '.');
  git(gitRepo, 'commit', '-q', '-m', 'docs');
  git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git(gitRepo, 'checkout', '-q', '-b', 'feat/r');
  fs.appendFileSync(path.join(gitRepo, 'docs/directives/convencoes.md'), 'amended\n');
  // datas fixas separam "antes" e "depois" dos registros, que nascem segundos antes do repositório
  const committedOn = (date: string) => ({ GIT_COMMITTER_DATE: date });
  gitWithEnv(
    gitRepo,
    committedOn('2099-01-01T00:00:00Z'),
    'commit',
    '-q',
    '-am',
    'amend convencoes',
  );
  fs.appendFileSync(path.join(gitRepo, 'docs/directives/invariantes.md'), 'amended\n');
  gitWithEnv(
    gitRepo,
    committedOn('2000-01-01T00:00:00Z'),
    'commit',
    '-q',
    '-am',
    'amend invariantes',
  );
  // só o diff contra o merge-base ignora `fluxo-hexlog.md`
  git(gitRepo, 'checkout', '-q', 'main');
  fs.appendFileSync(path.join(gitRepo, 'docs/directives/fluxo-hexlog.md'), 'amended on base\n');
  git(gitRepo, 'commit', '-q', '-am', 'amend fluxo-hexlog on base');
  git(gitRepo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git(gitRepo, 'checkout', '-q', 'feat/r');
  return gitRepo;
}

export type ReportFixture = {
  /** `XDG_DATA_HOME` com todos os processos. */
  xdg: string;
  /** `XDG_DATA_HOME` sem o processo `directives-9`, para o relatório falhar ao ler o processo de fora. */
  xdgWithoutDirectives: string;
  gitRepo: string;
  /** Id do registro de `feat-r`, `feat-c` ou `feat-class` pela chave do fixture. */
  idOf: (name: string) => string;
  /** Target do registro de `feat-r`, `feat-c` ou `feat-class` pela chave do fixture. */
  targetOf: (name: string) => string;
  /** Id do registro de `feat-inherit` pela chave do fixture. */
  inheritedIdOf: (name: string) => string;
  /** Ids das decisões vigentes de `feat-r` segundo a consulta do servidor. */
  currentIds: Set<string>;
};

/**
 * Os processos do relatório, cada um para um cenário:
 * - `feat-r`: decisões que citam só o objetivo ou a sentinela, e âncoras em doc alterado ou não;
 * - `feat-c`: lacunas críticas e premissas `simulated`; `feat-nopin` fixa o `premise` sem `answeredBy`;
 * - `feat-class`: o literal `Class:` do contexto da lacuna;
 * - `feat-clean`, `feat-inherit`: sem achado e com apoio herdado da linhagem;
 * - `feat-cut`, `feat-wide`, `feat-edge-lines`, `feat-edge-wide`: o corte de 100 linhas e de 10 premissas.
 */
export async function createReportFixture(): Promise<ReportFixture> {
  const environment = await createEnvironment();
  await defineFlowDefinitions(environment, { premise: premiseWithoutAnsweredBy() });
  // o processo fixa o `premise` sem `answeredBy`; a versão com o campo vale só dos próximos
  await environment.ok('create_process', { project: PROJECT, process: 'feat-nopin' });
  await environment.ok('define_type', {
    project: PROJECT,
    name: 'premise',
    schema: definitionOf('types', 'premise'),
  });
  for (const proc of [
    'directives-9',
    'feat-r',
    'feat-clean',
    'feat-cut',
    'feat-wide',
    'feat-edge-lines',
    'feat-edge-wide',
    'feat-inherit',
    'feat-c',
    'feat-class',
  ]) {
    await environment.ok('create_process', { project: PROJECT, process: proc });
  }
  const { hash: source } = await environment.ok<{ hash: string }>('attach', {
    project: PROJECT,
    text: 'rule text',
  });
  // `directives-9` (e não o `directives-N` real) prova que o relatório lê o processo pelo prefixo do id.
  const directives = await registerNamed(environment, 'directives-9', {
    r1: {
      type: 'directive',
      target: 'directives.convencoes.r1',
      data: { rule: 'Rule one', section: 'Section', source },
    },
    r2: {
      type: 'directive',
      target: 'directives.fluxo-hexlog.r2',
      data: { rule: 'Rule two', section: 'Section', source },
    },
    none: {
      type: 'premise',
      target: 'directives.estrategia.none',
      data: { statement: 'No premise applies' },
    },
  });
  const directive = lookup(directives, 'directive id');

  const items: Record<string, Item> = {};
  const ids: Record<string, string> = {};
  const registerFixture = async (proc: string, named: Record<string, Item>): Promise<void> => {
    Object.assign(ids, await registerNamed(environment, proc, named));
    for (const [name, item] of Object.entries(named)) items[name] = item;
  };

  await registerFixture('feat-r', {
    objective: premise('feat-r', 'objective'),
    alpha: premise('feat-r', 'alpha'),
    beta: premise('feat-r', 'beta'),
    gamma: premise('feat-r', 'gamma'),
    'd-obj': decision('feat-r', 'd-obj', [rests('@objective')]),
    'd-none': decision('feat-r', 'd-none', [rests(directive('none'))]),
    'd-both-none': decision('feat-r', 'd-both-none', [
      rests('@objective'),
      rests(directive('none')),
    ]),
    'd-revoked-prem': decision('feat-r', 'd-revoked-prem', [rests('@objective'), rests('@gamma')]),
    'd-ok': decision('feat-r', 'd-ok', [rests('@alpha')]),
    'd-doc': decision('feat-r', 'd-doc', [anchoredIn(directive('r1')), rests('@alpha')]),
    'd-far': decision('feat-r', 'd-far', [anchoredIn(directive('r2')), rests('@beta')]),
    'd-both': decision('feat-r', 'd-both', [anchoredIn(directive('r1')), rests('@objective')]),
    'd-no-rest': decision('feat-r', 'd-no-rest', []),
    'd-old': decision('feat-r', 'd-old', [rests('@objective')]),
    'd-new': decision(
      'feat-r',
      'd-new',
      [{ kind: 'supersedes', to: '@d-old' }, rests('@alpha')],
      'd-old',
    ),
    'd-rev': decision('feat-r', 'd-rev', [rests('@objective')]),
    'd-a': decision('feat-r', 'd-a', [rests('@objective')]),
    'd-b': decision('feat-r', 'd-b', [{ kind: 'supersedes', to: '@d-a' }, rests('@alpha')], 'd-a'),
    // revoga `d-rev` e o superseder `d-b`: nem `d-a` nem `d-b` voltam a valer
    revoker: gapOf('feat-r', 'revoker', 'Fixture', [
      { kind: 'revokes', to: '@d-rev' },
      { kind: 'revokes', to: '@d-b' },
    ]),
    // revoga a premissa `gamma`, que `d-revoked-prem` ainda cita
    'revoker-prem': gapOf('feat-r', 'revoker-prem', 'Fixture', [{ kind: 'revokes', to: '@gamma' }]),
  });

  const clean = await registerNamed(environment, 'feat-clean', {
    objective: premise('feat-clean', 'objective'),
    alpha: premise('feat-clean', 'alpha'),
  });
  await registerItems(environment, 'feat-clean', [
    decision('feat-clean', 'd-ok', [rests(lookup(clean, 'clean id')('alpha'))]),
  ]);

  // `d-new` não regrava o `rests-on` de `d-old`: o apoio só chega pela herança da linhagem
  const inheritedIds = await registerNamed(environment, 'feat-inherit', {
    objective: premise('feat-inherit', 'objective'),
    alpha: premise('feat-inherit', 'alpha'),
    'd-old': decision('feat-inherit', 'd-old', [rests('@objective')]),
    'd-new': decision('feat-inherit', 'd-new', [{ kind: 'supersedes', to: '@d-old' }], 'd-old'),
  });

  await registerFixture('feat-c', {
    objective: premise('feat-c', 'objective'),
    'g-open': criticalGap('feat-c', 'open', 'directives.fronteiras.r1'),
    'p-open-sim': premise('feat-c', 'open-sim', { answeredBy: 'simulated' }),
    'g-sim': criticalGap('feat-c', 'sim', 'directives.convencoes.r1'),
    'p-sim': premise('feat-c', 'sim', {
      answeredBy: 'simulated',
      relations: [fillsGap('@g-sim')],
    }),
    'g-ok': criticalGap('feat-c', 'ok', 'directives.invariantes.r2'),
    'p-ok-sim': premise('feat-c', 'ok-sim', { answeredBy: 'simulated' }),
    'p-ok': premise('feat-c', 'ok', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-ok'), { kind: 'derivesFrom', to: '@p-ok-sim' }],
    }),
    'g-noamend': criticalGap('feat-c', 'noamend', 'directives.fronteiras.r1'),
    'p-noamend': premise('feat-c', 'noamend', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-noamend')],
    }),
    'g-dir': criticalGap('feat-c', 'dir', 'directives.convencoes.r1'),
    'g-none': criticalGap('feat-c', 'none', 'directives.convencoes.r1'),
    'p-none': premise('feat-c', 'none', { relations: [fillsGap('@g-none')] }),
    'g-amended': criticalGap('feat-c', 'amended', 'directives.convencoes.r1'),
    'p-amended': premise('feat-c', 'amended', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-amended')],
    }),
    'g-human': criticalGap('feat-c', 'human', 'directives.invariantes.r2'),
    'p-human': premise('feat-c', 'human', {
      answeredBy: 'human',
      relations: [fillsGap('@g-human')],
    }),
    // `human` não precisa de emenda: decidiu outra coisa, a regra segue como está
    'g-human-nodiff': criticalGap('feat-c', 'human-nodiff', 'directives.fronteiras.r1'),
    'p-human-nodiff': premise('feat-c', 'human-nodiff', {
      answeredBy: 'human',
      relations: [fillsGap('@g-human-nodiff')],
    }),
    'g-human-late': criticalGap('feat-c', 'human-late', 'directives.convencoes.r1'),
    'p-human-late': premise('feat-c', 'human-late', {
      answeredBy: 'human',
      relations: [fillsGap('@g-human-late')],
    }),
    // dois fechadores: basta um aprovado (ou um não `human`) para o relatório acusar
    'g-two': criticalGap('feat-c', 'two', 'directives.convencoes.r1'),
    'p-two-approved': premise('feat-c', 'two-approved', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-two')],
    }),
    'p-two-simulated': premise('feat-c', 'two-simulated', {
      answeredBy: 'simulated',
      relations: [fillsGap('@g-two')],
    }),
    'g-two-nodiff': criticalGap('feat-c', 'two-nodiff', 'directives.fronteiras.r1'),
    'p-two-nodiff-human': premise('feat-c', 'two-nodiff-human', {
      answeredBy: 'human',
      relations: [fillsGap('@g-two-nodiff')],
    }),
    'p-two-nodiff-approved': premise('feat-c', 'two-nodiff-approved', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-two-nodiff')],
    }),
    'g-norule': gapOf('feat-c', 'norule', 'Class: critical'),
    'p-norule': premise('feat-c', 'norule', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-norule')],
    }),
    'g-common': gapOf('feat-c', 'common', 'Class: common'),
    'g-common-closed': gapOf('feat-c', 'common-closed', 'Class: common'),
    'p-common': premise('feat-c', 'common', {
      answeredBy: 'simulated',
      relations: [fillsGap('@g-common-closed')],
    }),
    'g-old': criticalGap('feat-c', 'old', 'directives.fronteiras.r1'),
    'g-new': gapOf(
      'feat-c',
      'new',
      'Class: critical; rule: directives.invariantes.r2',
      [{ kind: 'supersedes', to: '@g-old' }],
      'old',
    ),
    'p-new': premise('feat-c', 'new', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-new')],
    }),
    'g-revoked': criticalGap('feat-c', 'revoked', 'directives.invariantes.r2'),
    'p-revoked': premise('feat-c', 'revoked', {
      answeredBy: 'simulated-approved',
      relations: [fillsGap('@g-revoked')],
    }),
    'revoke-closer': gapOf('feat-c', 'revoke-closer', 'Fixture', [
      { kind: 'revokes', to: '@p-revoked' },
    ]),
    // a aprovação revogada deixa de valer: a decisão volta a apoiar-se só na `simulated`
    'p-rv-sim': premise('feat-c', 'rv-sim', { answeredBy: 'simulated' }),
    'p-rv-approved': premise('feat-c', 'rv-approved', {
      answeredBy: 'simulated-approved',
      relations: [{ kind: 'derivesFrom', to: '@p-rv-sim' }],
    }),
    'rv-revoker': gapOf('feat-c', 'rv-revoker', 'Fixture', [
      { kind: 'revokes', to: '@p-rv-approved' },
    ]),
    'd-rests-revoked': decision('feat-c', 'rests-revoked', [rests('@p-rv-sim')]),
    'd-rests-sim': decision('feat-c', 'rests-sim', [rests('@p-open-sim')]),
    'd-rests-approved': decision('feat-c', 'rests-approved', [rests('@p-ok-sim')]),
    'd-rests-common': decision('feat-c', 'rests-common', [rests('@p-common')]),
  });
  const idOf = lookup(ids, 'fixture id');
  // a diretriz que fecha a lacuna vive em `directives-9`, outro processo, como no dado real
  await registerItems(environment, 'directives-9', [
    {
      type: 'directive',
      target: 'directives.convencoes.r9',
      data: { rule: 'Rule nine', section: 'Section', source },
      relations: [{ kind: 'answers', as: 'closes-gap', to: idOf('g-dir') }],
    },
  ]);

  await registerNamed(environment, 'feat-nopin', {
    'g-nopin': criticalGap('feat-nopin', 'nopin', 'directives.invariantes.r2'),
    'p-nopin': premise('feat-nopin', 'nopin', { relations: [fillsGap('@g-nopin')] }),
  });

  // `Class:` fora do literal exato: o freio erra para o falso positivo
  const classOf = (context: string, short: string) =>
    gapOf('feat-class', short, `${context}; rule: directives.fronteiras.r1`);
  await registerFixture('feat-class', {
    'k-lower': classOf('class: critical', 'lower'),
    'k-tight': classOf('Class:critical', 'tight'),
    'k-spaced': classOf(' Class: critical', 'spaced'),
    'k-upper': classOf('Class: Critical', 'upper'),
    'k-longer': classOf('Class: criticality', 'longer'),
    'k-mixed': classOf('Class: common; critical', 'mixed'),
    // a natureza da dúvida vai depois da regra: a leitura da regra não pode tropeçar nela
    'k-nature': gapOf(
      'feat-class',
      'nature',
      'Class: critical; rule: directives.fronteiras.r1; Nature: choice',
    ),
    // ESC na regra: não chega ao stdout, a linha diz só que o doc é desconhecido
    'k-control': gapOf(
      'feat-class',
      'control',
      'Class: critical; rule: directives.adr\u001b[31m.x',
    ),
    'p-control': premise('feat-class', 'control', {
      answeredBy: 'human',
      relations: [fillsGap('@k-control')],
    }),
  });

  // o corte de 100 linhas não pode levar a lacuna crítica, que fica depois de 101 decisões
  await registerObjectiveFixture(environment, 'feat-cut', { premises: 0, decisions: 101 });
  await registerItems(environment, 'feat-cut', [
    criticalGap('feat-cut', 'open', 'directives.fronteiras.r1'),
  ]);
  await registerObjectiveFixture(environment, 'feat-wide', { premises: 12, decisions: 1 });
  // as bordas: 100 linhas e 10 premissas cabem inteiras, sem corte
  await registerObjectiveFixture(environment, 'feat-edge-lines', { premises: 0, decisions: 100 });
  await registerObjectiveFixture(environment, 'feat-edge-wide', { premises: 10, decisions: 1 });

  const { records: currentDecisions } = await environment.ok<QueryResult>('query', {
    project: PROJECT,
    process: 'feat-r',
    type: 'decision',
    limit: 200,
  });

  const xdg = copyToXdg(environment.dataDir);
  const xdgWithoutDirectives = copyToXdg(environment.dataDir);
  fs.rmSync(
    processPaths(path.join(xdgWithoutDirectives, 'hexlog'), {
      project: PROJECT,
      process: 'directives-9',
    }).dir,
    { recursive: true },
  );
  await environment.close();

  return {
    xdg,
    xdgWithoutDirectives,
    gitRepo: createGitRepo(),
    idOf,
    targetOf: (name) => lookup(items, 'fixture item')(name).target,
    inheritedIdOf: lookup(inheritedIds, 'inherited fixture id'),
    currentIds: new Set(currentDecisions.map((record) => record.id)),
  };
}
