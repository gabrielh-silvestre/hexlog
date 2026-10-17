import { describe, expect, it, jest } from '@jest/globals';
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { isUndefined } from 'es-toolkit';
import type { Detail } from '../../src/errors.ts';
import {
  type CallContext,
  READ_ANNOTATIONS,
  type ToolDeps,
  type ToolResult,
} from '../../src/mcp/kernel.ts';
import {
  CHANGES_ITEMS_CAP,
  EVIDENCE_ITEMS_CAP,
  queryPage,
  registerQueryTools,
} from '../../src/mcp/tools/query.ts';
import {
  PAGE_CHARS_CAP,
  QUERY_TEXT_MAX_CHARS,
  type QueryResult,
  type QueryService,
} from '../../src/queries/query-service.ts';

const idOf = (n: number) => `run-1:00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const idsOf = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => idOf(offset + i));

const recordOf = (count: number, value: string | null) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value]));

const emptyPage: QueryResult = { records: [], marker: {} };

/** Serviço falso que sempre devolve `result`, tipado para o `toHaveBeenCalledWith` conferir a entrada. */
const answering = (result: unknown) => jest.fn<(input: unknown) => unknown>(() => result);

function queryWith(page: QueryResult) {
  const queryRecords = jest.fn<QueryService['queryRecords']>(() => page);
  return { query: { queryRecords }, queryRecords };
}

type Handler = (args: unknown, ctx: CallContext) => Promise<ToolResult<unknown>>;

type Registered = {
  config: {
    title: string;
    description: string;
    outputSchema: StandardSchemaWithJSON;
    annotations: unknown;
  };
  handler: Handler;
};

type ErrorBody = { details: Detail[] };

/** Servidor falso: guarda o que `defineTool` passa ao `registerTool` (config e handler). */
function fakeServer() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function depsOf(query: Partial<Record<keyof QueryService, unknown>> = {}): ToolDeps {
  return {
    services: { query } as unknown as ToolDeps['services'],
    isLegacy: () => false,
    logger: jest.fn(),
  };
}

/** Registra as tools sobre um serviço falso e devolve o que o cliente MCP faria com elas. */
function registerQuery(query: Partial<Record<keyof QueryService, unknown>> = {}) {
  const { server, tools } = fakeServer();
  registerQueryTools(server, depsOf(query));

  const registered = (name: string) => {
    const tool = tools.get(name);
    if (isUndefined(tool)) throw new Error(`${name} was not registered`);
    return tool;
  };
  const call = (name: string, args: unknown) => registered(name).handler(args, { mcpReq: {} });

  return {
    call,
    descriptionOf: (name: string) => registered(name).config.description,
    outputOf: async (name: string, args: unknown) => {
      const result = await call(name, args);
      return 'structuredContent' in result ? result.structuredContent : undefined;
    },
    detailsOf: async (name: string, args: unknown): Promise<Detail[]> => {
      const result = await call(name, args);
      return 'isError' in result ? (JSON.parse(result.content[0].text) as ErrorBody).details : [];
    },
    validateOutput: async (name: string, value: unknown) =>
      registered(name).config.outputSchema['~standard'].validate(value),
  };
}

const QUERY_ARGS = { project: 'p', process: 'run-1' };

const GATE_ARGS = { project: 'p', process: 'run-1', gate: 'pre-pr' };

const record = {
  id: idOf(1),
  type: 'note',
  at: '2026-10-17T00:00:00.000Z',
  target: 'unit-1',
  inCounts: { supports: 1 },
  outCounts: { supports: 2 },
  in: [{ kind: 'supports' }],
  out: [{ kind: 'supports' }],
  data: { ref: 'x' },
};

const changes = {
  entered: [idOf(1)],
  left: [{ id: idOf(2), reason: 'superseded' }],
  marker: { 'run-1': idOf(2) },
  omitted: { entered: 1, left: 2 },
};

const queryOutput = {
  records: [record],
  cursor: 'next',
  marker: { 'run-1': idOf(1) },
  hint: 'a near miss',
  changes,
};

const gateQuestion = {
  index: 0,
  kind: 'approved',
  passed: false,
  counts: { of: 1 },
  evidence: { of: [idOf(1)] },
  omitted: { of: 2 },
};

const gateResult = { target: 'unit-1', passed: false, questions: [gateQuestion] };

const evaluateGateOutput = {
  passed: false,
  questions: [gateQuestion],
  results: [gateResult],
  marker: { 'run-1': idOf(1) },
};

const verifyChainOutput = {
  ok: false,
  totalRecords: 3,
  head: 'a'.repeat(64),
  breaks: [{ index: 1, reason: 'hash-mismatch' }],
  totalBreaks: 1,
  attachmentBreaks: [{ id: idOf(1), hash: 'b'.repeat(64), reason: 'attachment-missing' }],
  totalAttachmentBreaks: 1,
  repairedLines: [2],
};

const listOutput = {
  projects: [{ name: 'p', processes: 1 }],
  project: { name: 'p' },
  process: { name: 'run-1' },
};

const describeTypeOutput = { name: 'note', version: '1.0', schema: { type: 'object' } };

describe('queryPage', () => {
  it('should pass PAGE_CHARS_CAP as maxChars and forward the rest of the input (M4)', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', process: 'run-1', limit: 10 });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      process: 'run-1',
      limit: 10,
      relations: 'counts',
      maxChars: PAGE_CHARS_CAP,
    });
  });

  it('should forward fields to the service together with maxChars', () => {
    const { query, queryRecords } = queryWith(emptyPage);

    queryPage(query, { project: 'p', fields: ['ref'] });

    expect(queryRecords).toHaveBeenCalledWith({
      project: 'p',
      fields: ['ref'],
      relations: 'counts',
      maxChars: PAGE_CHARS_CAP,
    });
  });

  it.each(['full', 'none'] as const)(
    'should keep an explicit relations value of %s',
    (relations) => {
      const { query, queryRecords } = queryWith(emptyPage);

      queryPage(query, { project: 'p', relations });

      expect(queryRecords).toHaveBeenCalledWith(expect.objectContaining({ relations }));
    },
  );

  it('should return the page as it came when it has no changes', () => {
    const { query } = queryWith(emptyPage);

    expect(queryPage(query, { project: 'p' })).toEqual(emptyPage);
  });

  it.each([
    ['entered above the cap', CHANGES_ITEMS_CAP + 7, 1, { entered: 7, left: 0 }],
    ['left above the cap', 1, CHANGES_ITEMS_CAP + 3, { entered: 0, left: 3 }],
    ['both above the cap', CHANGES_ITEMS_CAP + 2, CHANGES_ITEMS_CAP + 5, { entered: 2, left: 5 }],
    ['exactly at the cap', CHANGES_ITEMS_CAP, CHANGES_ITEMS_CAP, undefined],
  ])(
    'should cap each changes list and report omitted when %s (M4)',
    (_title, enteredCount, leftCount, omitted) => {
      const entered = Array.from({ length: enteredCount }, (_, i) => idOf(i));
      const left = Array.from({ length: leftCount }, (_, i) => ({
        id: idOf(1_000 + i),
        reason: 'superseded' as const,
      }));
      const { query } = queryWith({ ...emptyPage, changes: { entered, left, marker: {} } });

      const { changes } = queryPage(query, { project: 'p' });

      expect(changes?.entered).toEqual(entered.slice(0, CHANGES_ITEMS_CAP));
      expect(changes?.left).toEqual(left.slice(0, CHANGES_ITEMS_CAP));
      expect(changes?.omitted).toEqual(omitted);
    },
  );
});

describe('registerQueryTools', () => {
  it('should register each read tool under its name with its title', () => {
    const { server, tools } = fakeServer();

    registerQueryTools(server, depsOf());

    expect([...tools].map(([name, { config }]) => [name, config.title])).toEqual([
      ['query', 'Query'],
      ['evaluate_gate', 'Evaluate gate'],
      ['verify_chain', 'Verify chain'],
      ['list', 'List'],
      ['describe_type', 'Describe type'],
    ]);
  });

  it('should mark every registered tool as read-only', () => {
    const { server, tools } = fakeServer();

    registerQueryTools(server, depsOf());

    expect([...tools.values()].map(({ config }) => config.annotations)).toEqual(
      Array.from({ length: 5 }, () => READ_ANNOTATIONS),
    );
  });

  describe('when describing the tools', () => {
    it('should state the contract of query in its description', () => {
      const { descriptionOf } = registerQuery();

      const description = descriptionOf('query');

      expect(description).toContain('Read the current records');
      expect(description).toContain('scope "project"');
      expect(description).toContain('at most 200 characters');
      expect(description).toContain('includeNonCurrent (also superseded or revoked)');
      expect(description).toContain('whole "."-separated segments');
      expect(description).toContain('carries a hint');
      expect(description).toContain('attachmentStatus');
      expect(description).toContain('per edge, current or not');
      expect(description).toContain('none gives neither');
      expect(description).toContain('inheritedIn and inheritedOut (full)');
      expect(description).toContain('origin {from, to} is the stored edge');
      expect(description).toContain('Process scope sees only its own relations');
      expect(description).toContain('project for cross-process ones');
      expect(description).toContain('fields (at most 50) keeps only those top-level names of data');
      expect(description).toContain('filters see the whole data');
      expect(description).toContain('default 50, max 200');
      expect(description).toContain('keeping at least one record');
      expect(description).toContain('any record id of the process works as its entry');
      expect(description).toContain('on the first page only');
      expect(description).toContain('Resend it with the cursor');
      expect(description).toContain(`changes lists at most ${CHANGES_ITEMS_CAP} ids`);
      expect(description).toContain('omitted ids never reappear');
      expect(description).toContain('reread everything');
      expect(description).toContain('in project scope others are read as empty');
      expect(description).toContain('fails with MARKER_NOT_FOUND or INVALID_CURSOR');
    });

    it('should state the contract of evaluate_gate in its description', () => {
      const { descriptionOf } = registerQuery();

      const description = descriptionOf('evaluate_gate');

      expect(description).toContain('GATE_NOT_FOUND otherwise');
      expect(description).toContain('one result per question (index, kind, passed)');
      expect(description).toContain('failing (default with target)');
      expect(description).toContain('counts (default with targets)');
      expect(description).toContain('approved has of, supports, contradictions and unsupported');
      expect(description).toContain('no_open_contradiction has conflicting');
      expect(description).toContain('inherit: true also counts support or resolution');
      expect(description).toContain('adds the list inherited');
      expect(description).toContain('target is inherited by selectors without');
      expect(description).toContain('targets (1 to 50, not with target or evidence full)');
      expect(description).toContain('one {target, passed, questions} per target');
      expect(description).toContain('evaluate that target alone with the batch marker');
      expect(description).toContain('replay the evaluation over the records that existed then');
      expect(description).toContain('covers exactly the processes it names');
      expect(description).toContain('A gate without project-scope questions reads one process');
      expect(description).toContain(`Each evidence list holds at most ${EVIDENCE_ITEMS_CAP} ids`);
      expect(description).toContain('a narrower select or where reaches them');
    });

    it('should state the contract of verify_chain in its description', () => {
      const { descriptionOf } = registerQuery();

      const description = descriptionOf('verify_chain');

      expect(description).toContain('the hash chain of its log');
      expect(description).toContain(
        'ok (true only when breaks and attachmentBreaks are both empty)',
      );
      expect(description).toContain('or the process anchor when the log has no link');
      expect(description).toContain('breaks and totalBreaks for the chain');
      expect(description).toContain('A broken chain is a result, not an error');
      expect(description).toContain('to detect a deleted or rewritten tail');
      expect(description).toContain('head-not-found break');
    });

    it('should state the contract of list in its description', () => {
      const { descriptionOf } = registerQuery();

      const description = descriptionOf('list');

      expect(description).toContain('Discover what exists');
      expect(description).toContain('the current types, relation names and gates');
      expect(description).toContain('the definition hashes');
    });

    it('should state the contract of describe_type in its description', () => {
      const { descriptionOf } = registerQuery();

      const description = descriptionOf('describe_type');

      expect(description).toContain('Read the JSON Schema of a record type');
      expect(description).toContain('returned as name and schema without version');
      expect(description).toContain('TYPE_NOT_PINNED when the process did not pin the type');
      expect(description).toContain('or the one asked by version');
      expect(description).toContain('PROJECT_NOT_FOUND when the project does not exist');
      expect(description).toContain('when it has no such type or version');
      expect(description).toContain('a legacy type may still store them');
      expect(description).toContain('needs `breaking: true`');
      expect(description).toContain('a version that is not <major>.<minor>');
      expect(description).toContain('INVALID_INPUT');
    });
  });

  describe('when forwarding the validated input to the service', () => {
    it('should answer query with the page that queryPage builds', async () => {
      const { query, queryRecords } = queryWith(emptyPage);
      const { outputOf } = registerQuery(query);

      const output = await outputOf('query', QUERY_ARGS);

      expect(output).toEqual(emptyPage);
      expect(queryRecords).toHaveBeenCalledWith({
        ...QUERY_ARGS,
        relations: 'counts',
        maxChars: PAGE_CHARS_CAP,
      });
    });

    it.each([
      ['failing', 'a target', { target: 'unit-1' }],
      ['counts', 'targets', { targets: ['unit-1', 'unit-2'] }],
      ['failing', 'neither target nor targets', {}],
    ])('should default evidence to %s when the call has %s', async (evidence, _what, extra) => {
      const evaluateGate = answering({ passed: true, questions: [], marker: {} });
      const { call } = registerQuery({ evaluateGate });

      await call('evaluate_gate', { ...GATE_ARGS, ...extra });

      expect(evaluateGate).toHaveBeenCalledWith({ ...GATE_ARGS, ...extra, evidence });
    });

    it('should keep the evidence mode that the call asks for', async () => {
      const evaluateGate = answering({ passed: true, questions: [], marker: {} });
      const { call } = registerQuery({ evaluateGate });

      await call('evaluate_gate', { ...GATE_ARGS, target: 'unit-1', evidence: 'full' });

      expect(evaluateGate).toHaveBeenCalledWith({
        ...GATE_ARGS,
        target: 'unit-1',
        evidence: 'full',
      });
    });

    it.each([
      ['verify_chain', 'verifyChain', { project: 'p', process: 'run-1' }],
      ['list', 'list', { project: 'p' }],
      ['describe_type', 'describeType', { project: 'p', type: 'note' }],
    ])('should answer %s with what the service returns', async (tool, method, input) => {
      const service = answering({ answeredBy: method });
      const { outputOf } = registerQuery({ [method]: service });

      const output = await outputOf(tool, input);

      expect(output).toEqual({ answeredBy: method });
      expect(service).toHaveBeenCalledWith(input);
    });
  });

  describe('when validating the input', () => {
    it('should cap where at 50 keys', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { ...QUERY_ARGS, where: recordOf(50, 'v') })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, where: recordOf(51, 'v') })).toEqual([
        { path: '/where', code: 'custom', message: 'has too many keys' },
      ]);
    });

    it.each([
      ['query', 'changesSince', QUERY_ARGS],
      ['evaluate_gate', 'marker', GATE_ARGS],
    ])('should cap the marker field of %s (%s) at 200 keys', async (tool, field, base) => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf(tool, { ...base, [field]: recordOf(200, null) })).toEqual([]);
      expect(await detailsOf(tool, { ...base, [field]: recordOf(201, null) })).toEqual([
        { path: `/${field}`, code: 'custom', message: 'has too many keys' },
      ]);
    });

    it('should refuse a lone surrogate in a where value', async () => {
      const { detailsOf } = registerQuery();

      expect(
        await detailsOf('query', { ...QUERY_ARGS, where: { a: '😀', b: 1, c: true } }),
      ).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, where: { a: 'ok', b: 'x\uD800' } })).toEqual(
        [{ path: '/where', code: 'custom', message: 'must not contain a lone surrogate' }],
      );
    });

    it('should refuse a lone surrogate in a where key', async () => {
      const { detailsOf } = registerQuery();

      expect(
        await detailsOf('query', { ...QUERY_ARGS, where: { a: 'ok', 'b\uD800': 'x' } }),
      ).toEqual([{ path: '/where', code: 'custom', message: 'must not contain a lone surrogate' }]);
    });

    it('should cap text at the query text limit', async () => {
      const { detailsOf } = registerQuery();

      expect(
        await detailsOf('query', { ...QUERY_ARGS, text: 'a'.repeat(QUERY_TEXT_MAX_CHARS) }),
      ).toEqual([]);
      expect(
        await detailsOf('query', { ...QUERY_ARGS, text: 'a'.repeat(QUERY_TEXT_MAX_CHARS + 1) }),
      ).toEqual([expect.objectContaining({ path: '/text', code: 'too_big' })]);
    });

    it('should refuse a lone surrogate in text', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { ...QUERY_ARGS, text: 'ok 😀' })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, text: 'ok \uD800' })).toEqual([
        { path: '/text', code: 'custom', message: 'must not contain a lone surrogate' },
      ]);
    });

    it('should cap ids at 200 entries', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { ...QUERY_ARGS, ids: idsOf(200) })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, ids: idsOf(201) })).toEqual([
        expect.objectContaining({ path: '/ids', code: 'too_big' }),
      ]);
    });

    it('should cap fields at 50 names', async () => {
      const { detailsOf } = registerQuery();
      const names = (count: number) => Array.from({ length: count }, (_, i) => `field${i}`);

      expect(await detailsOf('query', { ...QUERY_ARGS, fields: names(50) })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, fields: names(51) })).toEqual([
        expect.objectContaining({ path: '/fields', code: 'too_big' }),
      ]);
    });

    it('should refuse an empty field name', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { ...QUERY_ARGS, fields: ['ref', ''] })).toEqual([
        expect.objectContaining({ path: '/fields/1', code: 'too_small' }),
      ]);
    });

    it('should cap limit at 200', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { ...QUERY_ARGS, limit: 200 })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, limit: 201 })).toEqual([
        expect.objectContaining({ path: '/limit', code: 'too_big' }),
      ]);
    });

    it('should restrict scope to process and project', async () => {
      const { detailsOf } = registerQuery();

      expect(await detailsOf('query', { project: 'p', scope: 'project' })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, scope: 'process' })).toEqual([]);
      expect(await detailsOf('query', { ...QUERY_ARGS, scope: 'both' })).toEqual([
        expect.objectContaining({ path: '/scope', code: 'invalid_value' }),
      ]);
    });

    it('should accept between 1 and 50 targets in evaluate_gate', async () => {
      const { detailsOf } = registerQuery();
      const targets = (count: number) => Array.from({ length: count }, (_, i) => `unit-${i}`);

      expect(await detailsOf('evaluate_gate', { ...GATE_ARGS, targets: targets(1) })).toEqual([]);
      expect(await detailsOf('evaluate_gate', { ...GATE_ARGS, targets: targets(50) })).toEqual([]);
      expect(await detailsOf('evaluate_gate', { ...GATE_ARGS, targets: targets(0) })).toEqual([
        expect.objectContaining({ path: '/targets', code: 'too_small' }),
      ]);
      expect(await detailsOf('evaluate_gate', { ...GATE_ARGS, targets: targets(51) })).toEqual([
        expect.objectContaining({ path: '/targets', code: 'too_big' }),
      ]);
    });

    it('should point a since key to changesSince', async () => {
      const { detailsOf } = registerQuery();

      const [detail] = await detailsOf('query', { ...QUERY_ARGS, since: 'x', other: 1 });

      expect(detail).toMatchObject({ path: '', code: 'unrecognized_keys' });
      expect(detail?.message).toContain('"since", "other"');
      expect(detail?.message).toContain('use changesSince');
    });

    it('should leave the default message for an unknown key other than since', async () => {
      const { detailsOf } = registerQuery();

      const [detail] = await detailsOf('query', { ...QUERY_ARGS, other: 1 });

      expect(detail).toMatchObject({ path: '', code: 'unrecognized_keys' });
      expect(detail?.message).toContain('"other"');
      expect(detail?.message).not.toContain('changesSince');
    });
  });

  describe('when validating the output', () => {
    it.each([
      ['query', queryOutput],
      ['evaluate_gate', evaluateGateOutput],
      ['verify_chain', verifyChainOutput],
      ['list', listOutput],
      ['describe_type', describeTypeOutput],
    ])('should keep every field of the %s output', async (tool, output) => {
      const { validateOutput } = registerQuery();

      expect(await validateOutput(tool, output)).toEqual({ value: output });
    });

    it.each([
      ['query', 'the id of a record', { ...queryOutput, records: [{ ...record, id: 1 }] }],
      [
        'query',
        'the entered list of changes',
        { ...queryOutput, changes: { ...changes, entered: 'x' } },
      ],
      [
        'query',
        'the reason of a left entry',
        { ...queryOutput, changes: { ...changes, left: [{ id: idOf(2), reason: 1 }] } },
      ],
      [
        'evaluate_gate',
        'the index of a question',
        { ...evaluateGateOutput, questions: [{ ...gateQuestion, index: 'x' }] },
      ],
      [
        'evaluate_gate',
        'the passed flag of a target result',
        { ...evaluateGateOutput, results: [{ ...gateResult, passed: 'yes' }] },
      ],
      [
        'verify_chain',
        'the index of a break',
        { ...verifyChainOutput, breaks: [{ index: 'x', reason: 'hash-mismatch' }] },
      ],
      [
        'list',
        'the name of a listed project',
        { ...listOutput, projects: [{ name: 1, processes: 1 }] },
      ],
      ['list', 'the name of the project', { ...listOutput, project: { name: 1 } }],
      ['list', 'the name of the process', { ...listOutput, process: { name: 1 } }],
    ])('should refuse the %s output when %s has the wrong type', async (tool, _field, output) => {
      const { validateOutput } = registerQuery();

      expect(await validateOutput(tool, output)).toHaveProperty('issues');
    });
  });

  describe('when capping the evidence of evaluate_gate', () => {
    const overCap = idsOf(EVIDENCE_ITEMS_CAP + 3);
    const atCap = idsOf(EVIDENCE_ITEMS_CAP, 500);
    const few = idsOf(2, 900);
    const wide = {
      index: 0,
      kind: 'approved',
      passed: false,
      counts: { of: overCap.length, supports: atCap.length, unsupported: few.length },
      evidence: { of: overCap, supports: atCap, unsupported: few },
    };
    const narrow = {
      index: 1,
      kind: 'approved',
      passed: true,
      counts: { of: 2, supports: 2 },
      evidence: { of: few, supports: few },
    };

    it('should cut each evidence list at the cap and count what was left out per list', async () => {
      const evaluateGate = answering({
        passed: false,
        questions: [wide],
        marker: { 'run-1': null },
      });
      const { outputOf } = registerQuery({ evaluateGate });

      const output = await outputOf('evaluate_gate', { ...GATE_ARGS, target: 'unit-1' });

      expect(output).toEqual({
        passed: false,
        questions: [
          {
            ...wide,
            evidence: {
              of: overCap.slice(0, EVIDENCE_ITEMS_CAP),
              supports: atCap,
              unsupported: few,
            },
            omitted: { of: 3 },
          },
        ],
        marker: { 'run-1': null },
      });
    });

    it('should leave a question as it came when no list passes the cap', async () => {
      const evaluation = { passed: true, questions: [narrow], marker: {} };
      const { outputOf } = registerQuery({ evaluateGate: answering(evaluation) });

      const output = await outputOf('evaluate_gate', { ...GATE_ARGS, target: 'unit-1' });

      expect(output).toEqual(evaluation);
      expect(output).not.toHaveProperty('questions.0.omitted');
    });

    it('should cut the evidence of every question of every target in a batch', async () => {
      const evaluateGate = answering({
        passed: false,
        results: [
          { target: 'unit-1', passed: false, questions: [wide] },
          { target: 'unit-2', passed: true, questions: [narrow] },
        ],
        marker: { 'run-1': null },
      });
      const { outputOf } = registerQuery({ evaluateGate });

      const output = await outputOf('evaluate_gate', {
        ...GATE_ARGS,
        targets: ['unit-1', 'unit-2'],
      });

      expect(output).toEqual({
        passed: false,
        results: [
          {
            target: 'unit-1',
            passed: false,
            questions: [
              {
                ...wide,
                evidence: {
                  of: overCap.slice(0, EVIDENCE_ITEMS_CAP),
                  supports: atCap,
                  unsupported: few,
                },
                omitted: { of: 3 },
              },
            ],
          },
          { target: 'unit-2', passed: true, questions: [narrow] },
        ],
        marker: { 'run-1': null },
      });
    });
  });
});
