import type { McpServer } from '@modelcontextprotocol/server';
import { isUndefined } from 'es-toolkit';
import { z } from 'zod';
import { BatchKey } from '../../domain/chain.ts';
import { Name } from '../../domain/ids.ts';
import { Author, BATCH_MAX, BatchItem, WELL_FORMED } from '../../domain/record.ts';
import { defineTool, MarkerRecord, type ToolDeps, WRITE_ANNOTATIONS } from '../kernel.ts';

const CreateProcessInput = z.strictObject({ project: Name, process: Name });

// `agent` e `model` reusam o `Author` do domínio (teto e boa formação); o `client` o adaptador monta,
// o agente nunca o envia. A `key` entra no hash da cadeia como eles, então também exige boa formação.
const RegisterInput = z.strictObject({
  project: Name,
  process: Name,
  agent: Author.shape.agent,
  model: Author.shape.model,
  key: BatchKey.refine((key) => key.isWellFormed(), WELL_FORMED).optional(),
  records: z.array(BatchItem).min(1).max(BATCH_MAX),
});

const CreateProcessOutput = z.object({
  project: z.string(),
  process: z.string(),
  created: z.boolean(),
  pinned: z.record(z.string(), z.array(z.string())),
  stale: z
    .array(z.object({ kind: z.string(), name: z.string(), current: z.string().nullable() }))
    .optional(),
});

const RegisterOutput = z.object({
  records: z.array(z.object({ alias: z.string().optional(), id: z.string() })),
  replayed: z.boolean(),
  marker: MarkerRecord,
});

const CREATE_PROCESS_DESCRIPTION =
  'Create a process in a project. It pins the current version of every type, relation name and gate ' +
  'of the project; later registers in the process validate against that pin. Idempotent by name: an ' +
  'existing process comes back untouched (created=false), with stale listing the definitions that ' +
  'changed since the pin. Refuses a project with nothing defined (TYPE_NOT_FOUND) and reserved names.';

const REGISTER_DESCRIPTION =
  'Append a batch of 1 to 50 records to a process, atomically: all are written or none. agent is the ' +
  'agent or skill making the call, model is optional and self-declared, and the server fills client ' +
  'from the MCP client info. Each item has type (a type pinned in the process), target (dot-separated ' +
  'names), data (validated by the type schema, at most 16000 canonical characters), an optional alias ' +
  'and optional relations. A relation points at an existing record id or at "@alias" of an earlier ' +
  'item in the same batch, and carries kind (supersedes, revokes, supports, contradicts, answers, ' +
  'derivesFrom, complements, reopens), as (a relation name pinned in the process) or both. supersedes and revokes only reach records of ' +
  'the same process and need a current target (else FORK_REJECTED); supersedes also needs the same ' +
  'type; supports needs a current target. An attachment hash is accepted only in a field declared ' +
  'format "attachment". Pass key to make a retry safe: the same key with the same batch returns the ' +
  'records as stored with replayed=true and the current head as marker; with a different batch it ' +
  'fails with IDEMPOTENCY_CONFLICT. After ' +
  'IO_ERROR the outcome is uncertain: resend with the same key. Returns the ids in input order and ' +
  'the marker (head of the process) to read from afterwards. A marker covers exactly the processes ' +
  'it names; in project scope, any process it does not name is read as empty.';

/** `create_process` e `register`: cada uma só repassa a entrada validada ao serviço de processo. */
export function registerProcessTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    {
      name: 'create_process',
      schema: CreateProcessInput,
      title: 'Create process',
      description: CREATE_PROCESS_DESCRIPTION,
      outputSchema: CreateProcessOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    (input) => deps.services.process.createProcess(input),
  );

  defineTool(
    server,
    deps,
    {
      name: 'register',
      schema: RegisterInput,
      title: 'Register',
      description: REGISTER_DESCRIPTION,
      outputSchema: RegisterOutput,
      // Sem `key`, repetir a chamada grava de novo.
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    ({ agent, model, ...input }, client) =>
      deps.services.process.register({
        ...input,
        author: { agent, client, ...(isUndefined(model) ? {} : { model }) },
      }),
  );
}
