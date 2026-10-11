// Deep health check used by GET /api/health.
//
// The global load balancer (Cloudflare) calls /api/health on each cloud
// every ~60s. It must answer "can this cloud serve a real user right
// now?", so it asks every backend service for its /ready status (which in
// turn checks the service's database connection). If any backend is down
// the gateway answers 503 and Cloudflare sends users to another cloud.
const checkBackends = async (targets, { timeoutMs = 2000, fetchImpl = fetch } = {}) => {
  const results = await Promise.all(
    Object.entries(targets).map(async ([name, baseUrl]) => {
      try {
        const res = await fetchImpl(`${baseUrl}/ready`, {
          signal: AbortSignal.timeout(timeoutMs)
        });
        return [name, res.ok ? 'up' : 'down'];
      } catch (err) {
        return [name, 'down'];
      }
    })
  );

  const services = Object.fromEntries(results);
  const healthy = Object.values(services).every(status => status === 'up');
  return { healthy, services };
};

module.exports = { checkBackends };
