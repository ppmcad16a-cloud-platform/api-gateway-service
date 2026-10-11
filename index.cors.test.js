const http = require('http');
const express = require('express');
const request = require('supertest');

// Covers the CORS_ORIGINS branch: in production only our own website may
// call the API from a browser. Same listen-stub technique as
// index.defaults.test.js (no real gateway socket is opened).
jest.mock('dotenv', () => ({ config: () => {} }));

// A fake catalog backend that - like the real services - answers every
// request with a permissive CORS header the gateway must NOT pass on.
const permissiveBackend = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true'
  });
  res.end(JSON.stringify({ products: [] }));
});

let capturedApp;
const originalListen = express.application.listen;
express.application.listen = function (port, callback) {
  capturedApp = this;
  if (callback) callback();
  return { on: () => {} };
};

beforeAll(async () => {
  await new Promise(resolve => permissiveBackend.listen(0, resolve));

  process.env.LOG_LEVEL = 'silent';
  process.env.CORS_ORIGINS = 'https://shop.example.com, https://www.shop.example.com';
  process.env.IDENTITY_URL = 'http://localhost:1';
  process.env.CATALOG_URL = `http://localhost:${permissiveBackend.address().port}`;
  process.env.COMMERCE_URL = 'http://localhost:1';
  process.env.NOTIFICATION_URL = 'http://localhost:1';

  require('./index');
  express.application.listen = originalListen;
});

afterAll(() => new Promise(resolve => permissiveBackend.close(resolve)));

it('allows a configured origin', async () => {
  const res = await request(capturedApp)
    .get('/health')
    .set('Origin', 'https://www.shop.example.com');
  expect(res.headers['access-control-allow-origin']).toBe('https://www.shop.example.com');
});

it('does not allow an unknown origin', async () => {
  const res = await request(capturedApp).get('/health').set('Origin', 'https://evil.example.com');
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

it("ignores a backend's own permissive CORS headers on proxied responses", async () => {
  const evil = await request(capturedApp)
    .get('/api/product/list')
    .set('Origin', 'https://evil.example.com');
  expect(evil.status).toBe(200);
  expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  expect(evil.headers['access-control-allow-credentials']).toBeUndefined();

  const own = await request(capturedApp)
    .get('/api/product/list')
    .set('Origin', 'https://shop.example.com');
  expect(own.headers['access-control-allow-origin']).toBe('https://shop.example.com');
});
