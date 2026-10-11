// Logging + metrics shared by every Node service (the same file lives in
// each service repo so each repo stays independently buildable).
//
// - Logs: one JSON object per line on stdout (pino). In Kubernetes, Grafana
//   Alloy reads stdout of every container and ships it to Loki, where the
//   JSON fields (service, level, req.method, res.statusCode ...) become
//   searchable.
// - Metrics: Prometheus format on GET /metrics (prom-client). Prometheus
//   scrapes it every 30s. Includes Node.js process metrics (CPU, memory,
//   event-loop lag) and an HTTP request-duration histogram, which gives the
//   classic "RED" signals: Rate, Errors, Duration.
const pino = require('pino');
const pinoHttp = require('pino-http');
const promClient = require('prom-client');

// Probe and scrape endpoints are hit every few seconds by Kubernetes and
// Prometheus - logging them would drown out real traffic.
const QUIET_PATHS = ['/health', '/ready', '/metrics'];

// `destination` is only passed by tests (to capture log lines); in real use
// logs go to stdout.
const createObservability = ({ service, logLevel, routeLabel, destination }) => {
  const logger = pino({
    name: service,
    level: logLevel || 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // "level":"info" instead of pino's numeric "level":30 - easier to
    // filter on in Grafana/Loki.
    formatters: { level: label => ({ level: label }) },
    // Never write credentials into logs: logs are shipped to Loki and read
    // by many people. The value is replaced with "[Redacted]".
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]'
    ]
  }, destination);

  const httpLogger = pinoHttp({
    logger,
    autoLogging: { ignore: req => QUIET_PATHS.includes(req.url) },
    // 5xx = our fault (error), 4xx = caller's fault (warn), rest = info.
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    }
  });

  // A private registry (instead of prom-client's global one) means creating
  // the app twice - as the tests do - never fails with "metric already
  // registered".
  const registry = new promClient.Registry();
  registry.setDefaultLabels({ service });
  promClient.collectDefaultMetrics({ register: registry });

  const httpDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
  });

  // "route" must be a small, fixed set of values (never raw URLs with ids
  // in them), otherwise every product id would create a new time series.
  const metricsMiddleware = (req, res, next) => {
    const endTimer = httpDuration.startTimer();
    res.on('finish', () => {
      endTimer({
        method: req.method,
        route: routeLabel(req),
        status_code: res.statusCode
      });
    });
    next();
  };

  const metricsHandler = async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  };

  return { logger, httpLogger, metricsMiddleware, metricsHandler, registry };
};

module.exports = { createObservability, QUIET_PATHS };
