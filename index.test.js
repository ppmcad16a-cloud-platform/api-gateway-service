const http = require('http');
const express = require('express');
const request = require('supertest');
const Client = require('socket.io-client');
const socketio = require('socket.io');

process.env.PORT = '0';
process.env.BASE_API_URL = 'api';
process.env.LOG_LEVEL = 'silent';
delete process.env.CORS_ORIGINS;

// Four fake backend services, each just echoing back which service it is
// and the exact path/method it received — enough to prove the gateway
// routed a request to the right target without needing the real
// microservices running. notificationServer additionally carries a real
// Socket.IO server, to exercise the separate ws:true proxy + the raw HTTP
// server's 'upgrade' event wiring (index.js's one genuinely different code
// path from the four plain REST proxies).
const createEchoService = name =>
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: name, url: req.url, method: req.method }));
  });

const identityServer = createEchoService('identity');
const catalogServer = createEchoService('catalog');
const commerceServer = createEchoService('commerce');
const notificationServer = createEchoService('notification');
const notificationIo = socketio(notificationServer, { cors: { origin: '*' } });
notificationIo.on('connection', socket => {
  socket.emit('greeting', 'hello from notification');
});

const listenOn = server => new Promise(resolve => server.listen(0, resolve));

// index.js is a pure side-effect script (no module.exports) that calls
// app.listen(...) internally, so the only way to get a handle on the real
// server it starts — needed to hit it with supertest/socket.io-client and
// to close it afterward — is to intercept the Express prototype method
// it's about to call, before requiring the script. Same technique as
// catalog_server/notification_server's own index.test.js.
let capturedServer;
const originalListen = express.application.listen;
express.application.listen = function (...args) {
  capturedServer = originalListen.apply(this, args);
  return capturedServer;
};

beforeAll(async () => {
  await Promise.all(
    [identityServer, catalogServer, commerceServer, notificationServer].map(listenOn)
  );

  process.env.IDENTITY_URL = `http://localhost:${identityServer.address().port}`;
  process.env.CATALOG_URL = `http://localhost:${catalogServer.address().port}`;
  process.env.COMMERCE_URL = `http://localhost:${commerceServer.address().port}`;
  process.env.NOTIFICATION_URL = `http://localhost:${notificationServer.address().port}`;

  require('./index');
  express.application.listen = originalListen;

  await new Promise(resolve => {
    if (capturedServer.listening) return resolve();
    capturedServer.once('listening', resolve);
  });
});

afterAll(async () => {
  notificationIo.close();
  await new Promise(resolve => capturedServer.close(resolve));
  await Promise.all(
    [identityServer, catalogServer, commerceServer, notificationServer].map(
      s => new Promise(resolve => s.close(resolve))
    )
  );
});

describe.each([
  ['/api/auth/login', 'identity'],
  ['/api/user/me', 'identity'],
  ['/api/address', 'identity'],
  ['/api/product/list', 'catalog'],
  ['/api/category/list', 'catalog'],
  ['/api/brand/list', 'catalog'],
  ['/api/review', 'catalog'],
  ['/api/wishlist', 'catalog'],
  ['/api/graphql', 'commerce'],
  ['/api/contact/add', 'notification']
])('routing %s', (path, expectedService) => {
  it(`proxies to the ${expectedService} service, path unchanged`, async () => {
    const res = await request(capturedServer).get(path);

    expect(res.status).toBe(200);
    expect(res.body.service).toBe(expectedService);
    expect(res.body.url).toBe(path);
  });
});

it('does NOT expose the internal notification endpoint publicly', async () => {
  const res = await request(capturedServer).post('/api/notification/order-confirmation');
  expect(res.status).toBe(404);
  expect(res.body).toBe('No API route found');
});

it.each(['/health', '/ready'])('answers the Kubernetes probe %s', async path => {
  const res = await request(capturedServer).get(path);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

it('reports healthy on /api/health when every backend is ready', async () => {
  const res = await request(capturedServer).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    status: 'ok',
    services: { identity: 'up', catalog: 'up', commerce: 'up', notification: 'up' }
  });
});

it('exposes Prometheus metrics with low-cardinality route labels', async () => {
  await request(capturedServer).get('/api/product/list?page=2');
  await request(capturedServer).get('/api/graphql');
  await request(capturedServer).get('/not-under-api-prefix');

  const res = await request(capturedServer).get('/metrics');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  expect(res.text).toContain('http_request_duration_seconds_bucket');
  expect(res.text).toContain('route="/api/product"');
  expect(res.text).toContain('route="/api/graphql"');
  expect(res.text).toContain('route="other"');
  expect(res.text).toContain('service="api-gateway-service"');
  expect(res.text).toContain('process_cpu_user_seconds_total');
});

it('returns 404 with a JSON body for an unmatched path under the API prefix', async () => {
  const res = await request(capturedServer).get('/api/does-not-exist');
  expect(res.status).toBe(404);
  expect(res.body).toBe('No API route found');
});

it("leaves paths outside the API prefix to Express's own default handling", async () => {
  const res = await request(capturedServer).get('/not-under-api-prefix');
  expect(res.status).toBe(404);
  // The custom catch-all is scoped to `/api`, so a path outside it never
  // reaches that handler — Express's own default 404 page, not our JSON body.
  expect(res.body).not.toBe('No API route found');
});

it('applies cors() to proxied responses', async () => {
  const res = await request(capturedServer)
    .get('/api/product/list')
    .set('Origin', 'http://example.com');

  expect(res.headers['access-control-allow-origin']).toBe('*');
});

it('proxies the Socket.IO handshake (ws:true) through to notification_server', async () => {
  const port = capturedServer.address().port;
  const client = Client(`http://localhost:${port}`, {
    reconnection: false,
    forceNew: true,
    transports: ['websocket']
  });

  const greeting = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 5000);
    client.once('greeting', message => {
      clearTimeout(timer);
      resolve(message);
    });
    client.once('connect_error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });

  expect(greeting).toBe('hello from notification');
  client.close();
});
