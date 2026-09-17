import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil } from 'es-toolkit';
import { z } from 'zod';
import { sha256hex } from './chain.ts';
import {
  loadProcess,
  createProcess,
  readProject,
  listProjects,
  registerGate,
  registerType,
  registerVocabulary,
} from './definitions.ts';
import { HexlogError } from './errors.ts';
import { listBuiltinGates, CRITERIA_MAX_CHARS } from './gates.ts';
import {
  adaptarLoggerAjv,
  type Contexto,
  Definida,
  executar,
  Hash,
  Hashes,
  Instant,
  Name,
  Vocabulary,
} from './mcp.ts';

const Label = z.string().min(1).max(100);
const LabelList = z.array(Label).max(100).default([]);

/** Registra as 5 tools de definição (`listar`, `registrar_tipo`, `registrar_vocabulario`, `registrar_gate`, `criar_processo`). */
export function registrarFerramentasDefinicoes(servidor: McpServer, ctx: Contexto): void {
  servidor.registerTool(
    'listar',
    {
      title: 'Listar',
      description:
        'Lista projetos, ou o detalhe de um projeto, processo ou tipo fixado, conforme os parâmetros informados. ' +
        'Sem parâmetros, lista os projetos existentes. Sempre traz os gates embutidos disponíveis.',
      inputSchema: { project: Name.optional(), process: Name.optional(), type: Name.optional() },
      outputSchema: {
        projects: z.array(z.object({ name: Name, processes: z.number().int() })).optional(),
        project: z
          .object({
            name: Name,
            processes: z.array(z.object({ name: Name, createdAt: Instant })),
            types: z.array(z.object({ name: Name, hash: Hash })),
            vocabulary: z.array(z.object({ owner: Name, hash: Hash })),
            gates: z.array(z.object({ name: Name, hash: Hash })),
          })
          .optional(),
        process: z
          .object({
            name: Name,
            createdAt: Instant,
            hashes: Hashes,
            types: z.array(z.object({ name: Name, hash: Hash })),
            vocabulary: Vocabulary,
            gates: z.record(z.string(), z.object({ criteria: z.string() })),
          })
          .optional(),
        type: z
          .object({ name: Name, hash: Hash, schema: z.record(z.string(), z.unknown()) })
          .optional(),
        builtinGates: z.array(z.object({ name: Name, criteria: z.string() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, process, type }) =>
      executar(ctx, 'listar', { projeto: project, processo: process }, () =>
        resolveList(ctx, { project, process, type }),
      ),
  );

  servidor.registerTool(
    'registrar_tipo',
    {
      title: 'Registrar tipo',
      description:
        'Registra (ou substitui) o schema JSON de um tipo de evento custom do projeto, gravando `schemas/<name>.json`.',
      inputSchema: { project: Name, name: Name, schema: z.record(z.string(), z.unknown()) },
      outputSchema: Definida.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, name, schema }) =>
      executar(ctx, 'registrar_tipo', { projeto: project }, () => {
        const registered = registerType(ctx.dirDados, project, name, schema, {
          log: adaptarLoggerAjv(ctx.log),
        });
        return toDefinida(registered);
      }),
  );

  servidor.registerTool(
    'registrar_vocabulario',
    {
      title: 'Registrar vocabulário',
      description:
        'Registra (ou substitui) o vocabulário de um owner do projeto (`"core"` ou uma extensão), gravando `vocabulary/<owner>.json`.',
      inputSchema: {
        project: Name,
        owner: Name,
        milestoneType: LabelList,
        result: LabelList,
        action: LabelList,
      },
      outputSchema: { project: Name, owner: Name, hash: Hash, replaced: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, owner, milestoneType, result, action }) =>
      executar(ctx, 'registrar_vocabulario', { projeto: project }, () =>
        registerVocabulary(ctx.dirDados, project, owner, { milestoneType, result, action }),
      ),
  );

  servidor.registerTool(
    'registrar_gate',
    {
      title: 'Registrar gate',
      description:
        'Registra (ou substitui) o critério de um gate custom do projeto, gravando `gates/<name>.json`.',
      inputSchema: {
        project: Name,
        name: Name,
        criteria: z.string().min(1).max(CRITERIA_MAX_CHARS),
      },
      outputSchema: Definida.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, name, criteria }) =>
      executar(ctx, 'registrar_gate', { projeto: project }, () => {
        const registered = registerGate(ctx.dirDados, project, name, criteria);
        return toDefinida(registered);
      }),
  );

  servidor.registerTool(
    'criar_processo',
    {
      title: 'Criar processo',
      description:
        'Cria um novo processo, fixando o snapshot atual de tipos, vocabulário e gates do projeto em `process.json`. ' +
        'Falha se o processo já existir ou se o projeto não tiver nenhum vocabulário registrado.',
      inputSchema: { project: Name, process: Name },
      outputSchema: {
        project: Name,
        process: Name,
        createdAt: Instant,
        hashes: z.object({ schemas: Hash, vocabulario: Hash, gates: Hash }),
        types: z.array(Name),
        owners: z.array(Name),
        gates: z.array(Name),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process }) =>
      executar(ctx, 'criar_processo', { projeto: project, processo: process }, () =>
        createProcess(ctx.dirDados, project, process, ctx.relogio),
      ),
  );
}

/** `Definida` (mcp.ts, contrato ainda pt-BR na Fase 4) espera `{projeto,nome,hash,substituiu}`;
 *  `registerType`/`registerGate` (Fase 3) já devolvem `{project,name,hash,replaced}`. */
function toDefinida(registered: {
  project: string;
  name: string;
  hash: string;
  replaced: boolean;
}): { projeto: string; nome: string; hash: string; substituiu: boolean } {
  return {
    projeto: registered.project,
    nome: registered.name,
    hash: registered.hash,
    substituiu: registered.replaced,
  };
}

/** Hash do mesmo formato de `Definida` (§4.10): sha256 do JSON canônico (JCS) do schema. */
function hashSchema(schema: object): string {
  return sha256hex(canonicalize(schema) ?? '');
}

/** Lógica dos 4 níveis de `listar` (§4.12): projects → project → process → type. */
function resolveList(
  ctx: Contexto,
  { project, process, type }: { project?: string; process?: string; type?: string },
) {
  if (isNil(project) && isNotNil(process)) {
    throw new HexlogError('INVALID_INPUT', 'process requires project', [
      {
        path: '/process',
        code: 'requires_project',
        message: 'process given without project',
      },
    ]);
  }
  if (isNil(process) && isNotNil(type)) {
    throw new HexlogError('INVALID_INPUT', 'type requires process', [
      { path: '/type', code: 'requires_process', message: 'type given without process' },
    ]);
  }

  const builtinGates = listBuiltinGates();

  if (isNil(project)) {
    return {
      builtinGates,
      projects: listProjects(ctx.dirDados).map((p) => ({
        name: p.name,
        processes: p.processes.length,
      })),
    };
  }

  if (isNil(process)) {
    return { builtinGates, project: readProject(ctx.dirDados, project) };
  }

  const loaded = loadProcess(ctx.dirDados, project, process);

  if (isNil(type)) {
    return {
      builtinGates,
      process: {
        name: process,
        createdAt: loaded.manifest.createdAt,
        hashes: loaded.manifest.hashes,
        types: Object.entries(loaded.manifest.fixed.types).map(([typeName, schema]) => ({
          name: typeName,
          hash: hashSchema(schema),
        })),
        vocabulary: loaded.manifest.fixed.vocabulary,
        gates: loaded.manifest.fixed.gates,
      },
    };
  }

  const schema = loaded.manifest.fixed.types[type];
  if (isNil(schema)) {
    throw new HexlogError('TYPE_NOT_FOUND', `type '${type}' is not fixed in process '${process}'`);
  }
  return { builtinGates, type: { name: type, hash: hashSchema(schema), schema } };
}
