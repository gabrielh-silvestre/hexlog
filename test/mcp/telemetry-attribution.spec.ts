import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { isUndefined } from 'es-toolkit';
import { processPaths } from '../../src/adapters/fs/data-format.ts';
import { MAX_LOG_BYTES } from '../../src/adapters/fs/process-store.ts';
import type { LoadReport, Telemetry } from '../../src/ports.ts';
import { createEnvironment, NOTE_SCHEMA, PROJECT, type Environment } from './environment.ts';

type Call = { tool: string; loads: LoadReport[] };

/**
 * Telemetria falsa que guarda, por chamada, os `recordLoad` crus, com o mesmo isolamento por
 * chamada que o adaptador real faz (`AsyncLocalStorage`).
 */
function recordingTelemetry() {
  const calls: Call[] = [];
  const storage = new AsyncLocalStorage<Call>();
  const telemetry: Telemetry = {
    enabled: true,
    trace: (tool, run) => {
      const call: Call = { tool, loads: [] };
      calls.push(call);
      return storage.run(call, () => run({ end: () => undefined }));
    },
    recordLoad: (load) => void storage.getStore()?.loads.push(load),
    degraded: () => undefined,
    shutdown: () => Promise.resolve(),
  };
  const lastCall = (tool: string): Call => {
    const found = calls.findLast((call) => call.tool === tool);
    if (isUndefined(found)) throw new Error(`no ${tool} call was traced`);
    return found;
  };
  return { telemetry, lastCall };
}

describe('execute', () => {
  let environment: Environment;
  let lastCall: ReturnType<typeof recordingTelemetry>['lastCall'];

  const ref = (process: string) => ({ project: PROJECT, process });

  beforeEach(async () => {
    const fake = recordingTelemetry();
    lastCall = fake.lastCall;
    environment = await createEnvironment({ telemetry: fake.telemetry });
    await environment.ok('define_type', { project: PROJECT, name: 'note', schema: NOTE_SCHEMA });
    await environment.ok('create_process', { project: PROJECT, process: 'run-a' });
    await environment.ok('create_process', { project: PROJECT, process: 'run-b' });
  });

  afterEach(async () => {
    await environment.close();
  });

  it('should report the size without lines for a log above the cap', async () => {
    const log = processPaths(environment.dataDir, ref('run-a')).log;
    fs.truncateSync(log, MAX_LOG_BYTES + 1);

    await environment.fail(
      'register',
      {
        project: PROJECT,
        process: 'run-a',
        agent: 'executor',
        records: [{ type: 'note', target: 'run.step', data: { text: 'x' } }],
      },
      'PROCESS_TOO_LARGE',
    );

    expect(lastCall('register').loads).toStrictEqual([
      { ref: ref('run-a'), role: 'read' },
      { ref: ref('run-a'), role: 'target', bytes: MAX_LOG_BYTES + 1 },
    ]);
  });

  it('should report a repeated create_process as the target and then as a read, without a size', async () => {
    await environment.ok('create_process', { project: PROJECT, process: 'run-c' });

    await environment.ok('create_process', { project: PROJECT, process: 'run-c' });

    expect(lastCall('create_process').loads).toStrictEqual([
      { ref: ref('run-c'), role: 'target' },
      { ref: ref('run-c'), role: 'read' },
    ]);
  });

  it('should report only the named process as a read, without a size, for list with a process', async () => {
    await environment.ok('list', { project: PROJECT, process: 'run-a' });

    expect(lastCall('list').loads).toStrictEqual([{ ref: ref('run-a'), role: 'read' }]);
  });
});
