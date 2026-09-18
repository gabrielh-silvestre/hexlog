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
  adaptAjvLogger,
  type Context,
  Registered,
  execute,
  Hash,
  Hashes,
  Instant,
  Name,
  Vocabulary,
  Warning,
} from './mcp.ts';

const Label = z.string().min(1).max(100);
const LabelList = z.array(Label).max(100).default([]);

// §correção C5: `versions` aparece em dois níveis de `list` com o mesmo nome mas semânticas
// diferentes — descrições Zod deixam isso explícito pra quem lê só a superfície MCP.
const CURRENT_VERSION_DESC =
  'Current version on disk for this definition. Mutable: changes on every new register_* call, ' +
  'unlike the versions fixed inside a process manifest.';
const ALL_VERSIONS_DESC = 'Every version ever registered for this definition, in ascending order.';
const FIXED_VERSIONS_DESC =
  'Versions fixed at create_process time. Immutable after creation, unlike the current version ' +
  'reported by project-level list. Outside verifyHashes, so this block can be edited on disk ' +
  'without triggering PROCESS_CORRUPTED — a known limitation for anyone using it as an audit trail.';

/** Campos comuns às entradas de `types`/`vocabulary`/`gates` do `list` nível-projeto. */
const projectDefinitionVersionFields = {
  version: z.string().describe(CURRENT_VERSION_DESC),
  versions: z.array(z.string()).describe(ALL_VERSIONS_DESC),
};

/** Bloco `versions` de um manifesto de processo (`fixed` implícito no nome): mesmo shape em `list` nível-processo e `create_process`. */
const FixedVersions = z.object({
  types: z.record(z.string(), z.string()),
  vocabulary: z.record(z.string(), z.string()),
  gates: z.record(z.string(), z.string()),
});

/** Registra as 5 tools de definição (`list`, `register_type`, `register_vocabulary`, `register_gate`, `create_process`). */
export function registerDefinitionTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list',
    {
      title: 'List',
      description:
        'Lists projects, or the detail of a project, process or fixed type, depending on the parameters given. ' +
        'With no parameters, lists the existing projects. Always includes the available builtin gates.',
      inputSchema: { project: Name.optional(), process: Name.optional(), type: Name.optional() },
      outputSchema: {
        projects: z.array(z.object({ name: Name, processes: z.number().int() })).optional(),
        project: z
          .object({
            name: Name,
            processes: z.array(z.object({ name: Name, createdAt: Instant })),
            types: z.array(z.object({ name: Name, hash: Hash, ...projectDefinitionVersionFields })),
            vocabulary: z.array(
              z.object({ owner: Name, hash: Hash, ...projectDefinitionVersionFields }),
            ),
            gates: z.array(z.object({ name: Name, hash: Hash, ...projectDefinitionVersionFields })),
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
            versions: FixedVersions.optional().describe(FIXED_VERSIONS_DESC),
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
      execute(ctx, 'list', { project, process }, () =>
        resolveList(ctx, { project, process, type }),
      ),
  );

  server.registerTool(
    'register_type',
    {
      title: 'Register type',
      description:
        "Registers a new version of a custom event type's JSON schema for the project, writing " +
        '`schemas/<name>/<version>.json` (never replaces a prior version). Identical content is a ' +
        'no-op (`unchanged: true`). Any schema change is breaking and requires `breaking: true`.',
      inputSchema: {
        project: Name,
        name: Name,
        schema: z.record(z.string(), z.unknown()),
        breaking: z.boolean().optional(),
      },
      outputSchema: { ...Registered.shape, warnings: z.array(Warning) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, name, schema, breaking }) =>
      execute(ctx, 'register_type', { project }, () =>
        registerType(ctx.dataDir, project, name, schema, {
          log: adaptAjvLogger(ctx.log),
          breaking,
        }),
      ),
  );

  server.registerTool(
    'register_vocabulary',
    {
      title: 'Register vocabulary',
      description:
        'Registers a new version of a project owner\'s (`"core"` or an extension) vocabulary, writing ' +
        '`vocabulary/<owner>/<version>.json` (never replaces a prior version). Identical content is a ' +
        'no-op (`unchanged: true`). Removing a term from `milestoneType` or `action` is breaking and ' +
        'requires `breaking: true`; removing from `result` is not, since it is an open field.',
      inputSchema: {
        project: Name,
        owner: Name,
        milestoneType: LabelList,
        result: LabelList,
        action: LabelList,
        breaking: z.boolean().optional(),
      },
      outputSchema: {
        project: Name,
        owner: Name,
        hash: Hash,
        version: z.string(),
        previousVersion: z.string().nullable(),
        unchanged: z.boolean(),
        warnings: z.array(Warning),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, owner, milestoneType, result, action, breaking }) =>
      execute(ctx, 'register_vocabulary', { project }, () =>
        registerVocabulary(
          ctx.dataDir,
          project,
          owner,
          { milestoneType, result, action },
          { breaking },
        ),
      ),
  );

  server.registerTool(
    'register_gate',
    {
      title: 'Register gate',
      description:
        "Registers a new version of a custom gate's criteria for the project, writing " +
        '`gates/<name>/<version>.json` (never replaces a prior version). Identical content is a ' +
        'no-op (`unchanged: true`). No criteria change is breaking for a gate; `breaking: true` is ignored.',
      inputSchema: {
        project: Name,
        name: Name,
        criteria: z.string().min(1).max(CRITERIA_MAX_CHARS),
        breaking: z.boolean().optional(),
      },
      outputSchema: { ...Registered.shape, warnings: z.array(Warning) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, name, criteria, breaking }) =>
      execute(ctx, 'register_gate', { project }, () =>
        registerGate(ctx.dataDir, project, name, criteria, { breaking }),
      ),
  );

  server.registerTool(
    'create_process',
    {
      title: 'Create process',
      description:
        'Creates a new process, fixing the current snapshot of the project’s types, vocabulary and gates into `process.json`. ' +
        'Fails if the process already exists or if the project has no vocabulary registered.',
      inputSchema: { project: Name, process: Name },
      outputSchema: {
        project: Name,
        process: Name,
        createdAt: Instant,
        hashes: z.object({ schemas: Hash, vocabulary: Hash, gates: Hash }),
        types: z.array(Name),
        owners: z.array(Name),
        gates: z.array(Name),
        versions: FixedVersions.describe(FIXED_VERSIONS_DESC),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, process }) =>
      execute(ctx, 'create_process', { project, process }, () =>
        createProcess(ctx.dataDir, project, process, ctx.clock),
      ),
  );
}

/** Hash do mesmo formato de `Registered` (§4.10): sha256 do JSON canônico (JCS) do schema. */
function hashSchema(schema: object): string {
  return sha256hex(canonicalize(schema) ?? '');
}

/** Lógica dos 4 níveis de `list` (§4.12): projects → project → process → type. */
function resolveList(
  ctx: Context,
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
      projects: listProjects(ctx.dataDir).map((p) => ({
        name: p.name,
        processes: p.processes.length,
      })),
    };
  }

  if (isNil(process)) {
    return { builtinGates, project: readProject(ctx.dataDir, project) };
  }

  const loaded = loadProcess(ctx.dataDir, project, process);

  if (isNil(type)) {
    // spread condicional (não `versions: loaded.manifest.versions`): o SDK MCP preserva chaves com
    // valor `undefined` até a serialização, então setar a chave direto faria um processo legado
    // (sem o campo) devolver `versions: undefined` em vez do bloco realmente ausente.
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
        ...(isNotNil(loaded.manifest.versions) ? { versions: loaded.manifest.versions } : {}),
      },
    };
  }

  const schema = loaded.manifest.fixed.types[type];
  if (isNil(schema)) {
    throw new HexlogError('TYPE_NOT_FOUND', `type '${type}' is not fixed in process '${process}'`);
  }
  return { builtinGates, type: { name: type, hash: hashSchema(schema), schema } };
}
