// Graceful shutdown.
//
// During a rolling update Kubernetes sends SIGTERM to the old pod, waits,
// and only then kills it. Without this handler Node exits immediately and
// any request still in flight fails - users would see errors on every
// deploy. With it, the server stops accepting new connections, lets the
// in-flight requests finish, runs any extra cleanup (e.g. closing the DB
// connection) and only then exits.
//
// `timeoutMs` is a safety net: if something hangs, exit anyway before
// Kubernetes' own grace period (30s by default) runs out.
const registerShutdown = ({
  server,
  logger,
  cleanup = async () => {},
  timeoutMs = 20000,
  exit = code => process.exit(code),
  signals = ['SIGTERM', 'SIGINT'],
  processRef = process
}) => {
  let shuttingDown = false;

  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');

    const timer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    timer.unref();

    try {
      await new Promise(resolve => server.close(() => resolve()));
      await cleanup();
      logger.info('shutdown complete');
      exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      exit(1);
    } finally {
      clearTimeout(timer);
    }
  };

  signals.forEach(signal => processRef.on(signal, () => shutdown(signal)));
  return shutdown;
};

module.exports = { registerShutdown };
