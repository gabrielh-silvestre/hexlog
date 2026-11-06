import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { noopTelemetry } from '../../src/adapters/telemetry/noop.ts';
import { bindShutdown, type ShutdownProcess } from '../../src/adapters/telemetry/shutdown.ts';

const NEVER = (): Promise<void> => new Promise<void>(() => undefined);

function createFakeProc(stdinState: { readableEnded?: boolean; destroyed?: boolean } = {}) {
  const listeners = new Map<string, (() => void)[]>();
  const register = (event: string, listener: () => void): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const exit = jest.fn<(code?: number) => void>();
  const proc: ShutdownProcess = {
    stdin: {
      readableEnded: stdinState.readableEnded ?? false,
      destroyed: stdinState.destroyed ?? false,
      on: (event, listener) => register(event, listener),
    },
    on: (event, listener) => register(event, listener),
    once: (event, listener) => register(event, listener),
    exit,
  };
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  return { proc, exit, emit, listeners };
}

function bind(
  fake: ReturnType<typeof createFakeProc>,
  parts: { closeTransport?: () => Promise<void>; shutdown?: () => Promise<void> } = {},
) {
  const shutdown = jest.fn<(timeoutMs: number) => Promise<void>>(
    parts.shutdown ?? (() => Promise.resolve()),
  );
  const closeTransport = jest.fn(parts.closeTransport ?? (() => Promise.resolve()));
  bindShutdown({ telemetry: { ...noopTelemetry, shutdown }, proc: fake.proc, closeTransport });
  return { shutdown, closeTransport };
}

const settle = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

describe('bindShutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['end', 'close', 'beforeExit'])(
    'should shut down once and exit without a code on %s, even when repeated',
    async (event) => {
      const fake = createFakeProc();
      const { shutdown, closeTransport } = bind(fake);

      fake.emit(event);
      fake.emit(event);
      await settle();

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledWith(1_500);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(fake.exit).toHaveBeenCalledTimes(1);
      expect(fake.exit).toHaveBeenCalledWith(undefined);
    },
  );

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])('should shut down once and exit with %s code %i', async (signal, code) => {
    const fake = createFakeProc();
    const { shutdown } = bind(fake);

    fake.emit(signal);
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(250);
    expect(fake.exit).toHaveBeenCalledWith(code);
  });

  it('should share one shutdown across end, close and beforeExit', async () => {
    const fake = createFakeProc();
    const { shutdown } = bind(fake);

    fake.emit('end');
    fake.emit('close');
    fake.emit('beforeExit');
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it.each([{ readableEnded: true }, { destroyed: true }])(
    'should shut down at once when stdin is already finished (%o)',
    async (stdinState) => {
      const fake = createFakeProc(stdinState);

      const { shutdown } = bind(fake);
      await settle();

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(fake.exit).toHaveBeenCalledWith(undefined);
    },
  );

  it('should not shut down at bind time while stdin is open', async () => {
    const fake = createFakeProc();

    const { shutdown } = bind(fake);
    await settle(5_000);

    expect(shutdown).not.toHaveBeenCalled();
    expect(fake.exit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws synchronously',
      () => {
        throw new Error('boom');
      },
    ],
    ['rejects', () => Promise.reject(new Error('boom'))],
  ])('should still exit when the telemetry shutdown %s', async (_how, shutdownFails) => {
    const fake = createFakeProc();
    bind(fake, { shutdown: shutdownFails });

    fake.emit('end');
    await settle();

    expect(fake.exit).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledWith(undefined);
  });

  it('should still shut down the telemetry when closing the transport rejects', async () => {
    const fake = createFakeProc();
    const { shutdown } = bind(fake, { closeTransport: () => Promise.reject(new Error('boom')) });

    fake.emit('end');
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledWith(undefined);
  });

  it('should exit after 1,500 ms on the EOF when closing the transport is instant and the shutdown never ends', async () => {
    const fake = createFakeProc();
    bind(fake, { shutdown: NEVER });

    fake.emit('end');
    await settle(1_499);
    const exitedEarly = fake.exit.mock.calls.length;
    await settle(1);

    expect(exitedEarly).toBe(0);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it('should exit after 1,750 ms on the EOF when neither step ever ends', async () => {
    const fake = createFakeProc();
    bind(fake, { closeTransport: NEVER, shutdown: NEVER });

    fake.emit('end');
    await settle(1_749);
    const exitedEarly = fake.exit.mock.calls.length;
    await settle(1);

    expect(exitedEarly).toBe(0);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it('should exit after 250 ms on a signal when closing the transport is instant and the shutdown never ends', async () => {
    const fake = createFakeProc();
    bind(fake, { shutdown: NEVER });

    fake.emit('SIGTERM');
    await settle(249);
    const exitedEarly = fake.exit.mock.calls.length;
    await settle(1);

    expect(exitedEarly).toBe(0);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it('should exit after 350 ms on a signal when neither step ever ends', async () => {
    const fake = createFakeProc();
    bind(fake, { closeTransport: NEVER, shutdown: NEVER });

    fake.emit('SIGINT');
    await settle(349);
    const exitedEarly = fake.exit.mock.calls.length;
    await settle(1);

    expect(exitedEarly).toBe(0);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])(
    'should wait for the pending shutdown and then exit with %s code %i on a second one',
    async (signal, code) => {
      const fake = createFakeProc();
      const { shutdown } = bind(fake, { shutdown: NEVER });
      fake.emit(signal);
      await settle(100);

      fake.emit(signal);
      const exitedEarly = fake.exit.mock.calls.length;
      await settle(250);

      expect(exitedEarly).toBe(0);
      expect(fake.exit).toHaveBeenCalledTimes(1);
      expect(fake.exit).toHaveBeenCalledWith(code);
      expect(shutdown).toHaveBeenCalledTimes(1);
    },
  );

  it('should deliver the final export when SIGTERM arrives 100 ms after SIGINT and the shutdown takes 200 ms', async () => {
    const fake = createFakeProc();
    let delivered = false;
    const slowShutdown = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          delivered = true;
          resolve();
        }, 200);
      });
    const { shutdown } = bind(fake, { shutdown: slowShutdown });

    fake.emit('SIGINT');
    await settle(100);
    fake.emit('SIGTERM');
    const exitedEarly = fake.exit.mock.calls.length;
    await settle(100);

    expect(exitedEarly).toBe(0);
    expect(delivered).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledWith(130);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])(
    'should keep the EOF budget and exit with %s code %i when it arrives during a pending EOF shutdown',
    async (signal, code) => {
      const fake = createFakeProc();
      const { shutdown } = bind(fake, { shutdown: NEVER });
      fake.emit('end');
      await settle(100);

      fake.emit(signal);
      await settle(1_399);
      const exitedEarly = fake.exit.mock.calls.length;
      await settle(1);

      expect(exitedEarly).toBe(0);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledWith(1_500);
      expect(fake.exit).toHaveBeenCalledTimes(1);
      expect(fake.exit).toHaveBeenCalledWith(code);
    },
  );
});
