const { checkBackends } = require('./health');

const targets = { identity: 'http://identity', catalog: 'http://catalog' };

it('is healthy when every backend answers 2xx on /ready', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
  const result = await checkBackends(targets, { fetchImpl });

  expect(result).toEqual({ healthy: true, services: { identity: 'up', catalog: 'up' } });
  expect(fetchImpl).toHaveBeenCalledWith('http://identity/ready', expect.any(Object));
});

it('is unhealthy when a backend answers non-2xx', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false });
  const result = await checkBackends(targets, { fetchImpl });

  expect(result).toEqual({ healthy: false, services: { identity: 'up', catalog: 'down' } });
});

it('treats a network error or timeout as down', async () => {
  const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  const result = await checkBackends(targets, { fetchImpl });

  expect(result.healthy).toBe(false);
  expect(result.services).toEqual({ identity: 'down', catalog: 'down' });
});
