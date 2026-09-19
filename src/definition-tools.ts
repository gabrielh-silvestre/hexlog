import type { McpServer } from '@modelcontextprotocol/server';
import canonicalize from 'canonicalize';
import { isNil, isNotNil, omit } from 'es-toolkit';
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
  registerTransitions,
  FixedVersions,
} from './definitions.ts';
import { HexlogError } from './errors.ts';
import { listBuiltinGates, CRITERIA_MAX_CHARS, RuleGateSpec } from './gates.ts';
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
        'requires `breaking: true`; removing from `result` is not, since it is an open field. ' +
        '`breaking: true` on a compatible change adds a `NO_BREAKING_CHANGE` warning to the response ' +
        'instead of forcing a major bump. Optional `transitions` registers, in the same call, ' +
        "`owner`'s `from -> to` order over `milestoneType` (writing `transitions/<owner>/<version>.json`, " +
        'versioned independently, result under the `transitions` key of the response): once any pair ' +
        "declares a given `to`, `register`'ing a Milestone with that `milestoneType` requires the " +
        "target's current phase to be one of the declared `from` (or `null`, if a pair declares " +
        '`from: null`), otherwise it fails with `INVALID_TRANSITION`. A `milestoneType` with no pair ' +
        'declared for it stays unrestricted.',
      inputSchema: {
        project: Name,
        owner: Name,
        milestoneType: LabelList,
        result: LabelList,
        action: LabelList,
        transitions: z
          .array(z.object({ from: Name.nullable(), to: Name }))
          .max(100)
          .optional(),
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
        transitions: z
          .object({
            hash: Hash,
            version: z.string(),
            previousVersion: z.string().nullable(),
            unchanged: z.boolean(),
            warnings: z.array(Warning),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, owner, milestoneType, result, action, transitions, breaking }) =>
      execute(ctx, 'register_vocabulary', { project }, () => {
        const registered = registerVocabulary(
          ctx.dataDir,
          project,
          owner,
          { milestoneType, result, action },
          { breaking },
        );
        if (isNil(transitions)) return registered;

        const transitionsResult = registerTransitions(ctx.dataDir, project, owner, transitions, {
          breaking,
        });
        return { ...registered, transitions: omit(transitionsResult, ['project', 'owner']) };
      }),
  );

  server.registerTool(
    'register_gate',
    {
      title: 'Register gate',
      description:
        "Registers a new version of a custom gate's criteria for the project, writing " +
        '`gates/<name>/<version>.json` (never replaces a prior version). Identical content is a ' +
        'no-op (`unchanged: true`). No criteria/rule change is breaking for a gate: `breaking: true` ' +
        'never blocks the write or forces a major bump, it only adds a `NO_BREAKING_CHANGE` warning to ' +
        'the response. Optional `rule` turns this into a rule gate: `evaluate_gate` then computes ' +
        '`passed` itself from `state.active` (targets under `targetPattern` whose claim is vigent — or ' +
        'not, depending on `requireVigente` — and in `acceptedResults`, compared against `minCount`) ' +
        'instead of accepting a `result` from the agent; a `result` in that call fails with ' +
        '`INVALID_EVALUATION`, the same code a builtin gate uses for the same case. A gate registered ' +
        'without `rule` keeps behaving exactly as today (opinion gate, `result` required from the agent).',
      inputSchema: {
        project: Name,
        name: Name,
        criteria: z.string().min(1).max(CRITERIA_MAX_CHARS),
        rule: RuleGateSpec.optional(),
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
    async ({ project, name, criteria, rule, breaking }) =>
      execute(ctx, 'register_gate', { project }, () =>
        registerGate(ctx.dataDir, project, name, criteria, { breaking, rule }),
      ),
  );

  server.registerTool(
    'create_process',
    {
      title: 'Create process',
      description:
        'Creates a new process, fixing the current snapshot of the project’s types, vocabulary and gates into ' +
        '`process.json`. Idempotent: if the process already exists, returns it with `existed: true` instead of ' +
        'failing. If the snapshot fixed back then still matches the project’s current definitions, no warning; ' +
        'if it diverged since (a `register_*` happened after `create_process`), a `STALE_DEFINITIONS` warning ' +
        'lists what changed. Fails only if the project has no vocabulary registered.',
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
        existed: z.boolean(),
        warnings: z.array(Warning),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
