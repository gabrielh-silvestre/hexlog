import { describe, expect, it } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

const HOSTILE_NAMES = ['..', 'a/b'];

// O serviço confia nos tipos; a barreira anti-traversal é dos adaptadores (`process-store.ts#pathsOf`,
// `attachment-store.ts#checkedSegments`). Estes casos travam o contrato visível no serviço, para
// quem trocar a porta por outra.
describe('QueryService.queryRecords', () => {
  it.each(HOSTILE_NAMES)(
    'should refuse the process name %j with INVALID_INPUT invalid-name at /process',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() => queries.queryRecords({ project: PROJECT, process: name }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/process', code: 'invalid-name' });
    },
  );

  it.each(HOSTILE_NAMES)(
    'should refuse the project name %j with INVALID_INPUT invalid-name at /project',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() => queries.queryRecords({ project: name, process: 'run-1' }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/project', code: 'invalid-name' });
    },
  );

  it('should treat attachments and constructor as valid process names that do not exist', () => {
    const { queries, attachments } = querySetup();
    // Cria a pasta `<projeto>/attachments`, que não tem manifesto e nunca é um processo.
    attachments.putText(PROJECT, 'qualquer anexo');

    for (const process of ['attachments', 'constructor']) {
      const error = captureError(() => queries.queryRecords({ project: PROJECT, process }));

      expect(error.code).toBe('PROCESS_NOT_FOUND');
    }
  });

  describe('with relation names that clash with Object.prototype', () => {
    /** `support` aponta para `evidence` pela relação `constructor`; `superseded` troca um dos dois. */
    async function constructorEdge({ superseded }: { superseded?: 'support' | 'evidence' }) {
      const { definitions, createProcess, registerOne, query } = querySetup();
      definitions.write(PROJECT, 'relations', 'constructor', '1.0', {
        name: 'constructor',
        kind: 'supports',
      });
      createProcess('run-1');
      const evidence = await registerOne('run-1', note('evidence'), 1);
      const support = await registerOne(
        'run-1',
        note('support', { relations: [{ to: evidence, as: 'constructor' }] }),
        2,
      );
      if (superseded) {
        await registerOne(
          'run-1',
          note('replacement', {
            relations: [{ to: superseded === 'support' ? support : evidence, kind: 'supersedes' }],
          }),
          3,
        );
      }
      return { query, evidence, support };
    }

    it('should handle a relation named constructor in relations counts', async () => {
      const { query, evidence } = await constructorEdge({});

      const page = query({ process: 'run-1', ids: [evidence], relations: 'counts' });

      expect(at(page.records, 0).inCounts).toEqual({ constructor: 1 });
      expect(Object.hasOwn(at(page.records, 0).inCounts ?? {}, 'constructor')).toBe(true);
    });

    it.each([
      { side: 'nonCurrentInCounts', superseded: 'support', target: 'evidence' },
      { side: 'nonCurrentOutCounts', superseded: 'evidence', target: 'support' },
    ] as const)(
      'should handle a relation named constructor in $side',
      async ({ side, superseded, target }) => {
        const { query, ...ids } = await constructorEdge({ superseded });

        const page = query({ process: 'run-1', ids: [ids[target]], relations: 'counts' });

        expect(at(page.records, 0)[side]).toEqual({ constructor: 1 });
        expect(Object.hasOwn(at(page.records, 0)[side] ?? {}, 'constructor')).toBe(true);
      },
    );
  });
});

describe('QueryService.evaluateGate', () => {
  it.each(HOSTILE_NAMES)(
    'should refuse the process name %j with INVALID_INPUT invalid-name at /process',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() =>
        queries.evaluateGate({ project: PROJECT, process: name, gate: 'g' }),
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/process', code: 'invalid-name' });
    },
  );
});

describe('QueryService.verifyChain', () => {
  it.each(HOSTILE_NAMES)(
    'should refuse the process name %j with INVALID_INPUT invalid-name at /process',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() => queries.verifyChain({ project: PROJECT, process: name }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/process', code: 'invalid-name' });
    },
  );

  it.each(HOSTILE_NAMES)(
    'should refuse the project name %j with INVALID_INPUT invalid-name at /project',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() => queries.verifyChain({ project: name, process: 'run-1' }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/project', code: 'invalid-name' });
    },
  );
});

describe('QueryService.list', () => {
  it.each(HOSTILE_NAMES)(
    'should refuse the process name %j with INVALID_INPUT invalid-name at /process',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() => queries.list({ project: PROJECT, process: name }));

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/process', code: 'invalid-name' });
    },
  );
});

describe('QueryService.readAttachment', () => {
  it.each(HOSTILE_NAMES)(
    'should refuse the project name %j with INVALID_INPUT invalid-name at /project',
    (name) => {
      const { queries } = querySetup();

      const error = captureError(() =>
        queries.readAttachment({ project: name, hash: 'a'.repeat(64) }),
      );

      expect(error.code).toBe('INVALID_INPUT');
      expect(at(error.details, 0)).toMatchObject({ path: '/project', code: 'invalid-name' });
    },
  );
});
