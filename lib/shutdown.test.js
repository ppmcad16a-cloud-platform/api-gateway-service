const { EventEmitter } = require('events');
const { registerShutdown } = require('./shutdown');

const makeLogger = () => ({ info: jest.fn(), error: jest.fn() });
const makeServer = () => ({ close: jest.fn(callback => callback()) });

it('closes the server, runs cleanup and exits 0 on SIGTERM', async () => {
  const processRef = new EventEmitter();
  const server = makeServer();
  const cleanup = jest.fn().mockResolvedValue();
  const exit = jest.fn();

  const shutdown = registerShutdown({ server, logger: makeLogger(), cleanup, exit, processRef });
  await shutdown('SIGTERM');

  expect(server.close).toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(0);
});

it('listens for SIGTERM and SIGINT on the process', () => {
  const processRef = new EventEmitter();
  const exit = jest.fn();
  registerShutdown({ server: makeServer(), logger: makeLogger(), exit, processRef });

  expect(processRef.listenerCount('SIGTERM')).toBe(1);
  expect(processRef.listenerCount('SIGINT')).toBe(1);
  processRef.emit('SIGTERM');
});

it('only shuts down once even if signalled twice', async () => {
  const server = makeServer();
  const exit = jest.fn();
  const shutdown = registerShutdown({
    server,
    logger: makeLogger(),
    exit,
    processRef: new EventEmitter()
  });

  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  expect(server.close).toHaveBeenCalledTimes(1);
});

it('exits 1 when cleanup fails', async () => {
  const exit = jest.fn();
  const logger = makeLogger();
  const shutdown = registerShutdown({
    server: makeServer(),
    logger,
    cleanup: jest.fn().mockRejectedValue(new Error('db close failed')),
    exit,
    processRef: new EventEmitter()
  });

  await shutdown('SIGTERM');
  expect(exit).toHaveBeenCalledWith(1);
  expect(logger.error).toHaveBeenCalled();
});

it('forces exit 1 when shutdown hangs past the timeout', async () => {
  jest.useFakeTimers();
  const exit = jest.fn();
  const hangingServer = { close: jest.fn() }; // never calls back
  const shutdown = registerShutdown({
    server: hangingServer,
    logger: makeLogger(),
    timeoutMs: 1000,
    exit,
    processRef: new EventEmitter()
  });

  shutdown('SIGTERM');
  jest.advanceTimersByTime(1000);
  expect(exit).toHaveBeenCalledWith(1);
  jest.useRealTimers();
});

it('uses the real process and process.exit by default', async () => {
  const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

  const shutdown = registerShutdown({
    server: makeServer(),
    logger: makeLogger(),
    signals: ['SIGUSR2']
  });
  expect(onSpy).toHaveBeenCalledWith('SIGUSR2', expect.any(Function));

  await shutdown('SIGUSR2');
  expect(exitSpy).toHaveBeenCalledWith(0);

  onSpy.mockRestore();
  exitSpy.mockRestore();
});
