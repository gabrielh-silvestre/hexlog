import * as fs from 'node:fs';
import * as path from 'node:path';
import { omit } from 'es-toolkit';
import { z } from 'zod';
import { createValidator } from '../src/adapters/validator.ts';
import type { Defined } from '../src/commands/definition.ts';
import { createProcessService, type RegisterResult } from '../src/commands/process.ts';
import { Name } from '../src/domain/ids.ts';
import { createUuids } from './commands/fakes.ts';
import { at, parseJson } from './helpers.ts';
import { type Environment, createEnvironment } from './mcp/environment.ts';
import { diskStores } from './queries/query-setup.ts';

const hexlogDir = path.join(__dirname, '..', '.hexlog');

const PROJECT = 'hexlog';

type Kind = 'types' | 'relations' | 'gates';
export const KINDS: Kind[] = ['types', 'relations', 'gates'];
const DEFINE_TOOL: Record<Kind, string> = {
  types: 'define_type',
  relations: 'define_relation',
  gates: 'define_gate',
};

export const namesIn = (kind: Kind): string[] =>
  fs
    .readdirSync(path.join(hexlogDir, kind))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();

const fileBody = (kind: Kind, name: string): Record<string, unknown> =>
  parseJson(
    z.record(z.string(), z.json()),
    fs.readFileSync(path.join(hexlogDir, kind, `${name}.json`), 'utf8'),
  );

/** Corpo que a chamada `define_*` recebe a partir do arquivo: o tipo é o schema; as demais levam o nome. */
export const definitionOf = (kind: Kind, name: string): Record<string, unknown> =>
  kind === 'types' ? fileBody(kind, name) : { name, ...fileBody(kind, name) };

/** Entrada da tool `define_*` para o arquivo: o tipo leva o schema (`schema` o troca); as demais, o corpo com o nome. */
export const defineArgs = (
  kind: Kind,
  name: string,
  schema?: Record<string, unknown>,
): Record<string, unknown> =>
  kind === 'types'
    ? { name, schema: schema ?? definitionOf(kind, name) }
    : definitionOf(kind, name);

/**
 * Define em `environment` todo tipo, relação e gate de `.hexlog/`, na chave `<kind>/<name>`.
 * `schemas` troca o schema de um tipo pelo nome, para o caso que fixa uma versão antiga dele.
 */
export async function defineFlowDefinitions(
  environment: Environment,
  schemas: Record<string, Record<string, unknown>> = {},
): Promise<Record<string, Defined>> {
  const defined: Record<string, Defined> = {};
  for (const kind of KINDS) {
    for (const name of namesIn(kind)) {
      defined[`${kind}/${name}`] = await environment.ok<Defined>(DEFINE_TOOL[kind], {
        project: PROJECT,
        ...defineArgs(kind, name, schemas[name]),
      });
    }
  }
  return defined;
}

/** Servidor em memória com as definições de `.hexlog/` e um processo aberto por `slugs`. */
export async function createFlowEnvironment(slugs: readonly string[]): Promise<Environment> {
  const environment = await createEnvironment();
  await defineFlowDefinitions(environment);
  for (const slug of slugs) {
    await environment.ok('create_process', { project: PROJECT, process: slug });
  }
  return environment;
}

/**
 * Abre `slug` sem `lineageInheritance`, como um processo anterior à herança: `create_process` sempre a liga,
 * então o processo nasce pelo serviço com o campo tirado do manifesto.
 */
export function createLegacyLineageProcess(environment: Environment, slug: string): void {
  const stores = diskStores(environment.dataDir);
  createProcessService({
    ...stores,
    store: {
      ...stores.store,
      create: (ref, manifest) => stores.store.create(ref, omit(manifest, ['lineageInheritance'])),
    },
    validator: createValidator(),
    clock: () => new Date(),
    newUuid: createUuids(),
    logger: () => undefined,
  }).createProcess({ project: Name.parse(PROJECT), process: Name.parse(slug) });
}

export type FlowRecord = {
  type: string;
  target: string;
  data: Record<string, unknown>;
  relations?: Record<string, unknown>[];
};

/** Registra um registro em `process` e devolve o id. */
export async function registerFlowRecord(
  environment: Environment,
  process: string,
  record: FlowRecord,
): Promise<string> {
  const { records } = await environment.ok<RegisterResult>('register', {
    project: PROJECT,
    process,
    agent: 'flow-run',
    records: [record],
  });
  return at(records, 0).id;
}
