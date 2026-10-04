import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BATCH_KEY_MAX } from '../../domain/chain.ts';
import { Name } from '../../domain/ids.ts';
import { Author, BATCH_MAX, BatchItem } from '../../domain/record.ts';
import { advertise, execute, type ToolDeps, WELL_FORMED, wellFormed } from '../kernel.ts';

const CreateProcessInput = z.strictObject({ project: Name, process: Name });

const wellFormedString = (schema: z.ZodString) =>
  schema.refine((text) => wellFormed([text]), WELL_FORMED);

// `agent` e `model` reusam o teto do `Author`; o `client` o adaptador monta, o agente nunca o envia.
// As três strings livres entram no hash da cadeia, então exigem boa formação.
const RegisterInput = z.strictObject({
  project: Name,
  process: Name,
  agent: wellFormedString(Author.shape.agent),
  model: wellFormedString(Author.shape.model.unwrap()).optional(),
  key: wellFormedString(z.string().min(1).max(BATCH_KEY_MAX)).optional(),
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
  marker: z.record(z.string(), z.string().nullable()),
});

const CREATE_PROCESS_DESCRIPTION =
  'Create a process in a project. It pins the current version of every type, relation name and gate ' +
  'of the project; later registers in the process validate against that pin. Idempotent by name: an ' +
  'existing process comes back untouched (created=false), with stale listing the definitions that ' +
  'changed since the pin. Refuses a project with nothing defined (TYPE_NOT_FOUND) and reserved names.';

const REGISTER_DESCRIPTION =
  'Append a batch of 1 to 50 records to a process, atomically: all are written or none. Each item has ' +
  'type (a type pinned in the process), target (dot-separated names), data (validated by the type ' +
  'schema, at most 16000 canonical characters), an optional alias and optional relations. A relation ' +
  'points at an existing record id or at "@alias" of an earlier item in the same batch, and carries ' +
  'kind (supersedes, revokes, supports, contradicts, answers, derivesFrom, complements, reopens), ' +
  'as (a relation name defined in the project) or both. supersedes and revokes only reach records of ' +
  'the same process. Pass key to make a retry safe: the same key with the same batch returns the ' +
  'stored result with replayed=true; with a different batch it fails with IDEMPOTENCY_CONFLICT. After ' +
  'IO_ERROR the outcome is uncertain: resend with the same key. Returns the ids in input order and ' +
  'the marker (head of the process) to read from afterwards. A marker covers exactly the processes ' +
  'it names; in project scope, any process it does not name is read as empty.';

/** `create_process` e `register`: cada uma só repassa a entrada validada ao serviço de processo. */
export function registerProcessTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'create_process',
    {
      description: CREATE_PROCESS_DESCRIPTION,
      inputSchema: advertise(CreateProcessInput),
      outputSchema: CreateProcessOutput,
      annotations: { readOnlyHint: false },
    },
    (args, ctx) =>
      execute(deps, { name: 'create_process', schema: CreateProcessInput, args, ctx }, (input) =>
        deps.services.process.createProcess(input),
      ),
  );

  server.registerTool(
    'register',
    {
      description: REGISTER_DESCRIPTION,
      inputSchema: advertise(RegisterInput),
      outputSchema: RegisterOutput,
      annotations: { readOnlyHint: false },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    (args, ctx) =>
      execute(
        deps,
        { name: 'register', schema: RegisterInput, args, ctx },
        ({ agent, model, ...input }, caller) =>
          deps.services.process.register({ ...input, author: caller.author({ agent, model }) }),
      ),
  );
}
