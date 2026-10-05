import { describe, expect, test } from '@jest/globals';
import { note } from '../commands/register-fakes.ts';
import { at, captureError } from '../helpers.ts';
import { idsOf, querySetup } from './query-setup.ts';

describe('queryRecords: alcance (D-24)', () => {
  test('o alcance processo lê só o processo pedido e o marcador tem uma entrada', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const mine = await registerOne('run-1', note('a'));
    await registerOne('run-2', note('b'));

    const page = query({ process: 'run-1' });

    expect(idsOf(page)).toEqual([mine]);
    expect(page.marker).toEqual({ 'run-1': mine });
  });

  test('P13: no alcance processo `in` ignora outro processo e `out` para outro processo sai sem current', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const target = await registerOne('run-2', note('destino'), 1);
    const source = await registerOne(
      'run-1',
      note('origem', { relations: [{ to: target, kind: 'supports' }] }),
      2,
    );

    const origin = query({ process: 'run-1' });
    const destination = query({ process: 'run-2' });

    expect(at(origin.records, 0).out).toStrictEqual([{ kind: 'supports', to: target }]);
    expect(at(destination.records, 0).in).toEqual([]);
    expect(destination.marker).toEqual({ 'run-2': target });
    expect(origin.marker).toEqual({ 'run-1': source });
  });

  test('P13: no alcance projeto `in` e `out.current` enxergam outro processo e o marcador cobre todos', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    createProcess('vazio');
    const target = await registerOne('run-2', note('destino'), 1);
    const source = await registerOne(
      'run-1',
      note('origem', { relations: [{ to: target, as: 'approves' }] }),
      2,
    );

    const page = query({ scope: 'project' });

    expect(idsOf(page)).toEqual([target, source]);
    expect(at(page.records, 0).in).toEqual([
      { kind: 'supports', as: 'approves', from: source, current: true },
    ]);
    expect(at(page.records, 1).out).toEqual([
      { kind: 'supports', as: 'approves', to: target, current: true },
    ]);
    expect(page.marker).toEqual({ 'run-1': source, 'run-2': target, vazio: null });
  });

  test('P13: processo com cadeia quebrada falha fechado, nomeado, só onde foi lido', async () => {
    const { createProcess, register, registerOne, tamper, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    await registerOne('run-1', note('ok'));
    await register('run-2', [note('vai quebrar'), note('e denuncia')]);
    tamper('run-2');

    const project = captureError(() => query({ scope: 'project' }));
    const own = captureError(() => query({ process: 'run-2' }));

    expect(project.code).toBe('PROCESS_CORRUPTED');
    expect(at(project.details, 0)).toMatchObject({ code: 'broken-chain', process: 'run-2' });
    expect(own.code).toBe('PROCESS_CORRUPTED');
    expect(query({ process: 'run-1' }).records).toHaveLength(1);
  });

  test('alcance projeto com projeto inexistente é PROJECT_NOT_FOUND, como o `list`', () => {
    const { queries } = querySetup();

    const error = captureError(() => queries.queryRecords({ project: 'ghost', scope: 'project' }));

    expect(error.code).toBe('PROJECT_NOT_FOUND');
    expect(error.details).toEqual([
      { path: '/project', code: 'unknown-project', message: expect.any(String) },
    ]);
  });

  test('projeto existente sem processos devolve página vazia, não PROJECT_NOT_FOUND', () => {
    const { query } = querySetup();

    expect(query({ scope: 'project' })).toEqual({ records: [], marker: {} });
  });

  test('alcance processo sem `process` e processo inexistente são recusados', () => {
    const { createProcess, query } = querySetup();
    createProcess('run-1');

    const missingName = captureError(() => query({}));
    const unknown = captureError(() => query({ process: 'nao-existe' }));

    expect(missingName.code).toBe('INVALID_FILTER');
    expect(at(missingName.details, 0).path).toBe('/process');
    expect(unknown.code).toBe('PROCESS_NOT_FOUND');
  });

  test('P13: o `in` do alcance processo lista só as origens do próprio processo e o projeto lista todas', async () => {
    const { createProcess, registerOne, query } = querySetup();
    createProcess('run-1');
    createProcess('run-2');
    const target = await registerOne('run-2', note('destino'), 1);
    await registerOne(
      'run-1',
      note('aprova', { relations: [{ to: target, kind: 'supports' }] }),
      2,
    );
    const own = await registerOne(
      'run-2',
      note('revisa', { relations: [{ to: target, kind: 'supports' }] }),
      3,
    );

    const destination = query({ process: 'run-2', ids: [target] });
    const project = query({ scope: 'project', ids: [target] });

    expect(at(destination.records, 0).in).toEqual([{ kind: 'supports', from: own, current: true }]);
    expect(at(project.records, 0).in).toHaveLength(2);
  });
});
