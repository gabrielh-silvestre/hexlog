import { describe, expect, test } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { PROJECT, querySetup } from './query-setup.ts';

// O serviço confia nos tipos; a barreira anti-traversal é dos adaptadores (`process-store.ts#pathsOf`,
// `attachment-store.ts#checkedSegments`). Estes casos travam o contrato visível no serviço, para
// quem trocar a porta por outra.
describe('queries: nomes hostis', () => {
  test.each(['..', 'a/b'])(
    'processo %j é INVALID_INPUT `invalid-name` em /process, em toda operação que o recebe',
    (name) => {
      const { queries } = querySetup();
      const calls = [
        () => queries.queryRecords({ project: PROJECT, process: name }),
        () => queries.evaluateGate({ project: PROJECT, process: name, gate: 'g' }),
        () => queries.verifyChain({ project: PROJECT, process: name }),
        () => queries.list({ project: PROJECT, process: name }),
      ];

      for (const call of calls) {
        const error = captureError(call);
        expect(error.code).toBe('INVALID_INPUT');
        expect(at(error.details, 0)).toMatchObject({ path: '/process', code: 'invalid-name' });
      }
    },
  );

  test.each(['..', 'a/b'])(
    'projeto %j é INVALID_INPUT `invalid-name` em /project, em toda operação que o recebe',
    (name) => {
      const { queries } = querySetup();
      const calls = [
        () => queries.queryRecords({ project: name, process: 'run-1' }),
        () => queries.verifyChain({ project: name, process: 'run-1' }),
        () => queries.readAttachment({ project: name, hash: 'a'.repeat(64) }),
      ];

      for (const call of calls) {
        const error = captureError(call);
        expect(error.code).toBe('INVALID_INPUT');
        expect(at(error.details, 0)).toMatchObject({ path: '/project', code: 'invalid-name' });
      }
    },
  );

  test('`attachments` e `constructor` são nomes válidos de processo que não existem', () => {
    const { queries, attachments } = querySetup();
    // Cria a pasta `<projeto>/attachments`, que não tem manifesto e nunca é um processo.
    attachments.putText(PROJECT, 'qualquer anexo');

    for (const process of ['attachments', 'constructor']) {
      const error = captureError(() => queries.queryRecords({ project: PROJECT, process }));
      expect(error.code).toBe('PROCESS_NOT_FOUND');
    }
  });
});

describe('queries: relation names that clash with Object.prototype', () => {
  test('relations counts handles a relation named constructor', async () => {
    const { definitions, createProcess, registerOne, query } = querySetup();
    definitions.write(PROJECT, 'relations', 'constructor', '1.0', {
      name: 'constructor',
      kind: 'supports',
    });
    createProcess('run-1');
    const evidence = await registerOne('run-1', note('evidence'), 1);
    await registerOne(
      'run-1',
      note('support', { relations: [{ to: evidence, as: 'constructor' }] }),
      2,
    );

    const page = query({ process: 'run-1', ids: [evidence], relations: 'counts' });

    expect(at(page.records, 0).inCounts).toEqual({ constructor: 1 });
    expect(Object.hasOwn(at(page.records, 0).inCounts ?? {}, 'constructor')).toBe(true);
  });
});
