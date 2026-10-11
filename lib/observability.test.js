const { Writable } = require('stream');
const express = require('express');
const request = require('supertest');
const { createObservability } = require('./observability');

// Collects every JSON log line the logger writes.
const lines = [];
const destination = new Writable({
  write(chunk, encoding, callback) {
    lines.push(JSON.parse(chunk.toString()));
    callback();
  }
});

const { httpLogger } = createObservability({
  service: 'test-svc',
  routeLabel: () => 'r',
  destination
});

const app = express();
app.use(httpLogger);
app.get('/ok', (req, res) => res.send('ok'));
app.get('/missing', (req, res) => res.status(404).send('nope'));
app.get('/boom', (req, res) => res.status(500).send('boom'));
app.get('/health', (req, res) => res.send('ok'));

const requestLines = () => lines.filter(line => line.req);

beforeEach(() => {
  lines.length = 0;
});

it('logs 2xx at info, 4xx at warn, 5xx at error and skips probe paths', async () => {
  await request(app).get('/ok');
  await request(app).get('/missing');
  await request(app).get('/boom');
  await request(app).get('/health');

  const levelByUrl = Object.fromEntries(requestLines().map(line => [line.req.url, line.level]));
  expect(levelByUrl).toEqual({ '/ok': 'info', '/missing': 'warn', '/boom': 'error' });
});

it('adds the service name and a readable level to every line', async () => {
  await request(app).get('/ok');
  expect(requestLines()[0]).toMatchObject({ service: 'test-svc', level: 'info' });
});

it('redacts credentials from request logs', async () => {
  await request(app)
    .get('/ok')
    .set('Authorization', 'Bearer secret-token')
    .set('Cookie', 'sid=secret-cookie');

  const line = requestLines()[0];
  expect(line.req.headers.authorization).toBe('[Redacted]');
  expect(line.req.headers.cookie).toBe('[Redacted]');
  expect(JSON.stringify(line)).not.toMatch(/secret-token|secret-cookie/);
});
