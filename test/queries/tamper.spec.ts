import { describe, expect, it } from '@jest/globals';
import { note } from '../commands/fakes.ts';
import { at, captureError, cursorOf, idsOf } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

async function untouched() {
  const setup = querySetup();
  setup.createProcess('run-1');
  setup.createProcess('run-2');
  const ids = [];
  for (const text of ['primeira', 'segunda', 'terceira']) {
    ids.push(await setup.registerOne('run-1', note(text), 1));
  }
  const other = await setup.registerOne('run-2', note('de outro processo'), 2);
  return { ...setup, ids, other };
}

describe('QueryService.queryRecords', () => {
  it('should return the records of a process with no tampering', async () => {
    const { query, ids } = await untouched();

    expect(idsOf(query({ process: 'run-1' }))).toEqual(ids);
  });

  it('should find a record by text in a process with no tampering', async () => {
    const { query, ids } = await untouched();

    expect(idsOf(query({ process: 'run-1', text: 'segunda' }))).toEqual([at(ids, 1)]);
  });

  it('should return the records of every process at the project scope with no tampering', async () => {
    const { query, ids, other } = await untouched();

    expect(idsOf(query({ scope: 'project' }))).toEqual([...ids, other]);
  });

  describe('with a tampered old line', () => {
    it('should detect the tampered line on the next call, without restarting the service', async () => {
      const { query, tamper } = await untouched();
      query({ process: 'run-1' });
      tamper('run-1');

      const error = captureError(() => query({ process: 'run-1' }));

      expect(error.code).toBe('PROCESS_CORRUPTED');
      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });

    it('should not serve the index from before the tampering on a text search', async () => {
      const { query, tamper } = await untouched();
      query({ process: 'run-1', text: 'segunda' });
      tamper('run-1');

      const error = captureError(() => query({ process: 'run-1', text: 'segunda' }));

      expect(error.code).toBe('PROCESS_CORRUPTED');
    });

    it('should fail the next page of a query in progress after the tampering', async () => {
      const { query, tamper } = await untouched();
      const first = query({ process: 'run-1', limit: 2 });
      tamper('run-1');

      const error = captureError(() =>
        query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
      );

      expect(error.code).toBe('PROCESS_CORRUPTED');
    });

    it('should give PROCESS_CORRUPTED, not MARKER_NOT_FOUND, for a cursor whose marker is the line rejected by the tampering of the previous one', async () => {
      const { query, tamperLine } = await untouched();
      const first = query({ process: 'run-1', limit: 2 });
      tamperLine('run-1', 1);

      const error = captureError(() =>
        query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
      );

      expect(error.code).toBe('PROCESS_CORRUPTED');
      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });

    it('should fail changesSince on a tampered process too, without returning a partial difference', async () => {
      const { query, tamper } = await untouched();
      const snapshot = query({ process: 'run-1' });
      tamper('run-1');

      const error = captureError(() => query({ process: 'run-1', changesSince: snapshot.marker }));

      expect(error.code).toBe('PROCESS_CORRUPTED');
    });
  });
});

describe('QueryService.evaluateGate', () => {
  describe('with a tampered old line', () => {
    it('should give PROCESS_CORRUPTED for a marker on the line rejected by the tampering of the previous one', async () => {
      const { queries, definitions, createProcess, registerOne, query, tamperLine } = querySetup();
      definitions.write(PROJECT, 'gates', 'any', '1.0', {
        name: 'any',
        questions: [{ kind: 'occurred', select: { type: 'note' } }],
      });
      createProcess('run-1');
      for (const text of ['primeira', 'segunda', 'terceira']) {
        await registerOne('run-1', note(text), 1);
      }
      const { marker } = query({ process: 'run-1' });
      tamperLine('run-1', 1);

      const error = captureError(() =>
        queries.evaluateGate({ project: PROJECT, process: 'run-1', gate: 'any', marker }),
      );

      expect(error.code).toBe('PROCESS_CORRUPTED');
      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });
  });
});
