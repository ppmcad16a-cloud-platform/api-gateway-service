// Reverse proxy in front of the 4 microservices. This is what client/ keeps
// pointing its single API_URL and Socket.IO connection at (port 3000,
// exactly where the original server/ monolith used to listen) — routing by
// path prefix means the client needed zero changes for the split.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createObservability } = require('./lib/observability');
const { checkBackends } = require('./lib/health');
const { registerShutdown } = require('./lib/shutdown');

const port = process.env.PORT || 3000;
const apiURL = process.env.BASE_API_URL || 'api';
const api = `/${apiURL}`;

const IDENTITY_URL = process.env.IDENTITY_URL;
const CATALOG_URL = process.env.CATALOG_URL;
const COMMERCE_URL = process.env.COMMERCE_URL;
const NOTIFICATION_URL = process.env.NOTIFICATION_URL;

// Comma-separated list of browser origins allowed to call the API, e.g.
// "https://rishavmukhopadhyay.store". Unset = allow any origin (local dev).
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// Path-prefix -> service routing table. Order matters only in that more
// specific paths would need to precede less specific ones — none overlap
// here, so registration order is arbitrary.
//
// /api/notification/* is deliberately NOT routed: it is an internal
// endpoint (commerce -> notification, inside the cluster) with no auth, so
// exposing it publicly would let anyone trigger e-mails.
const routes = [
  { name: 'identity', path: [`${api}/auth`, `${api}/user`, `${api}/address`], target: IDENTITY_URL },
  {
    name: 'catalog',
    path: [
      `${api}/product`,
      `${api}/category`,
      `${api}/brand`,
      `${api}/review`,
      `${api}/wishlist`
    ],
    target: CATALOG_URL
  },
  // commerce_server is a single GraphQL endpoint (not one REST path per
  // resource like the other three services).
  { name: 'commerce', path: [`${api}/graphql`], target: COMMERCE_URL },
  { name: 'notification', path: [`${api}/contact`], target: NOTIFICATION_URL }
];

// Metrics label: the matched prefix (e.g. "/api/product"), never the full
// URL, so ids in URLs don't create unlimited time series.
const routeLabel = req => {
  const url = req.originalUrl.split('?')[0];
  const prefixes = routes.flatMap(route => route.path).concat(`${api}/health`, '/socket.io');
  return prefixes.find(prefix => url === prefix || url.startsWith(`${prefix}/`)) || 'other';
};

const { logger, httpLogger, metricsMiddleware, metricsHandler } = createObservability({
  service: 'api-gateway-service',
  logLevel: process.env.LOG_LEVEL,
  routeLabel
});

const app = express();
app.disable('x-powered-by');
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(httpLogger);
app.use(metricsMiddleware);

// Kubernetes probes. The gateway has no database, so "alive" and "ready"
// are the same thing: the process is up and serving HTTP.
app.get(['/health', '/ready'], (req, res) => res.json({ status: 'ok' }));
app.get('/metrics', metricsHandler);

// Deep check for the global load balancer (see lib/health.js).
app.get(`${api}/health`, async (req, res) => {
  const result = await checkBackends(
    Object.fromEntries(routes.map(route => [route.name, route.target]))
  );
  res.status(result.healthy ? 200 : 503).json({
    status: result.healthy ? 'ok' : 'degraded',
    services: result.services
  });
});

// The gateway is the ONLY place that decides CORS. The backend services
// still send their own permissive "Access-Control-Allow-Origin: *"; if that
// header were passed through it would override the CORS_ORIGINS
// restriction above, so it is stripped from every proxied response.
const stripUpstreamCors = proxyRes => {
  Object.keys(proxyRes.headers)
    .filter(header => header.startsWith('access-control-'))
    .forEach(header => delete proxyRes.headers[header]);
};

routes.forEach(({ path, target }) => {
  app.use(
    path,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      onProxyRes: stripUpstreamCors
    })
  );
});

app.use(api, (req, res) => res.status(404).json('No API route found'));

// Socket.IO's handshake (client/app/contexts/Socket connects to the same
// origin as API_URL) needs its own proxy with ws:true so the connection
// upgrades to a websocket through the gateway instead of terminating here.
const socketProxy = createProxyMiddleware({
  target: NOTIFICATION_URL,
  changeOrigin: true,
  ws: true
});
app.use('/socket.io', socketProxy);

const server = app.listen(port, () => {
  logger.info({ port }, 'api-gateway-service listening');
});

// http-proxy-middleware needs the raw HTTP server's 'upgrade' event wired
// up separately to actually proxy websocket traffic — app.use() alone only
// handles regular HTTP requests.
server.on('upgrade', socketProxy.upgrade);

registerShutdown({ server, logger });
