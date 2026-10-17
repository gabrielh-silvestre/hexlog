import { describe, expect, it } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { cursorOf, idsOf, PROJECT, querySetup } from './query-setup.ts';

async function untouched() {
  const setup = querySetup();
  setup.definitions.write(PROJECT, 'gates', 'any', '1.0', {
    name: 'any',
    questions: [{ kind: 'occurred', select: { type: 'note' } }],
  });
  setup.createProcess('run-1');
  setup.createProcess('run-2');
  for (const text of ['primeira', 'segunda', 'terceira']) {
    await setup.registerOne('run-1', note(text), 1);
  }
  await setup.registerOne('run-2', note('de outro processo'), 2);
  return setup;
}

describe('QueryService.queryRecords', () => {
  describe('with a tampered old line', () => {
    it('should detect the tampered line on the next call, without restarting the service (SL5, D-24)', async () => {
      const { query, tamper } = await untouched();

      expect(query({ process: 'run-1' }).records).toHaveLength(3);

      tamper('run-1');

      const error = captureError(() => query({ process: 'run-1' }));

      expect(error.code).toBe('PROCESS_CORRUPTED');
      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });

    it('should not serve the index from before the tampering on a text search (SL5, D-24)', async () => {
      const { query, tamper } = await untouched();

      expect(idsOf(query({ process: 'run-1', text: 'segunda' }))).toHaveLength(1);

      tamper('run-1');

      const error = captureError(() => query({ process: 'run-1', text: 'segunda' }));

      expect(error.code).toBe('PROCESS_CORRUPTED');
    });

    it('should name the tampered process in the project scope, leaving the other one readable alone (SL5, D-24)', async () => {
      const { query, tamper } = await untouched();

      expect(query({ scope: 'project' }).records).toHaveLength(4);

      tamper('run-1');

      const project = captureError(() => query({ scope: 'project' }));

      expect(project.code).toBe('PROCESS_CORRUPTED');
      expect(at(project.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
      expect(query({ process: 'run-2' }).records).toHaveLength(1);
    });

    it('should fail the next page of a query in progress after the tampering (SL5, D-24)', async () => {
      const { query, tamper } = await untouched();
      const first = query({ process: 'run-1', limit: 2 });
      tamper('run-1');

      const error = captureError(() =>
        query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
      );

      expect(error.code).toBe('PROCESS_CORRUPTED');
    });

    it('should give PROCESS_CORRUPTED, not MARKER_NOT_FOUND, for a cursor whose marker is the line rejected by the tampering of the previous one (SL5, D-24)', async () => {
      const { query, tamperLine } = await untouched();
      const first = query({ process: 'run-1', limit: 2 });
      tamperLine('run-1', 1);

      const error = captureError(() =>
        query({ process: 'run-1', limit: 2, cursor: cursorOf(first) }),
      );

      expect(error.code).toBe('PROCESS_CORRUPTED');
      expect(at(error.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-1' });
    });

    it('should fail changesSince on a tampered process too, without returning a partial difference (SL5, D-24)', async () => {
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
    it('should give PROCESS_CORRUPTED for a marker on the line rejected by the tampering of the previous one (SL5, D-24)', async () => {
      const { queries, query, tamperLine } = await untouched();
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
