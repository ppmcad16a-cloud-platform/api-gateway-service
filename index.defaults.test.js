const express = require('express');
const request = require('supertest');

// index.js's `require('dotenv').config()` would otherwise silently refill
// PORT/BASE_API_URL (and everything else) from the real .env file the
// instant this test file deletes them below — dotenv only skips variables
// already present in process.env, it has no idea a test deleted them on
// purpose. Mocking it to a no-op is what actually lets the `|| 3000`/
// `|| 'api'` fallbacks in index.js get exercised.
jest.mock('dotenv', () => ({ config: () => {} }));

// Covers the `process.env.PORT || 3000` / `process.env.BASE_API_URL ||
// 'api'` fallback branches — index.test.js always sets both explicitly
// (PORT=0 for a real ephemeral bind), so those defaults are otherwise never
// exercised. Binding to the literal port 3000 for a test would be flaky
// (conflicts with a real dev stack), so express.application.listen is
// replaced with a stub that captures the Express `app` instance (via
// `this`) and the requested port/callback WITHOUT actually opening a
// socket — supertest can drive `app` directly without a real .listen() at
// all, and the captured args are enough to assert what index.js asked for.
let capturedApp;
let capturedPort;
const originalListen = express.application.listen;
express.application.listen = function (port, callback) {
  capturedApp = this;
  capturedPort = port;
  if (callback) callback();
  return { on: () => {} };
};

beforeAll(() => {
  delete process.env.PORT;
  delete process.env.BASE_API_URL;
  // http-proxy-middleware throws synchronously at *creation* time (not
  // request time) if `target` is falsy, so these need some truthy string —
  // this file never sends a proxied request, only checks the catch-all
  // 404's registration prefix, so the value itself never needs to resolve
  // to anything real.
  process.env.IDENTITY_URL = 'http://localhost:1';
  process.env.CATALOG_URL = 'http://localhost:1';
  process.env.COMMERCE_URL = 'http://localhost:1';
  process.env.NOTIFICATION_URL = 'http://localhost:1';

  require('./index');
  express.application.listen = originalListen;
});

it('defaults to port 3000 when PORT is unset', () => {
  expect(capturedPort).toBe(3000);
});

it("defaults BASE_API_URL to 'api', registering the catch-all under /api", async () => {
  const res = await request(capturedApp).get('/api/does-not-exist');
  expect(res.status).toBe(404);
  expect(res.body).toBe('No API route found');
});
