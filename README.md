# api-gateway-service

The single entry point for the MERN shop's API. It receives every `/api` and `/socket.io` request from the web client and forwards it to the right backend service. It also answers the deep health check (`/api/health`) that the global load balancer uses to decide whether a whole cloud can serve shoppers.

**Stack:** Node.js 22 · Express · http-proxy-middleware · pino · prom-client

## Where it fits

| | |
|---|---|
| **Called by** | [client-service](https://github.com/ppmcad16a-cloud-platform/client-service) (browser) through the cluster's Envoy Gateway; Cloudflare's load-balancer monitor (`/api/health`) |
| **Calls** | [identity-service](https://github.com/ppmcad16a-cloud-platform/identity-service), [catalog-service](https://github.com/ppmcad16a-cloud-platform/catalog-service), [commerce-service](https://github.com/ppmcad16a-cloud-platform/commerce-service), [notification-service](https://github.com/ppmcad16a-cloud-platform/notification-service) |
| **Built by** | shared workflows in [core-cloud-platform](https://github.com/ppmcad16a-cloud-platform/core-cloud-platform) (`node-app.yaml@v2`) |
| **Deployed by** | Helm chart + Jenkins pipeline in [platform-deployments](https://github.com/ppmcad16a-cloud-platform/platform-deployments) |

### Routes

| Prefix | Forwarded to |
|---|---|
| `/api/auth`, `/api/user`, `/api/address` | identity-service |
| `/api/product`, `/api/category`, `/api/brand`, `/api/review`, `/api/wishlist` | catalog-service |
| `/api/graphql` | commerce-service |
| `/api/contact`, `/socket.io` (WebSocket) | notification-service |

`/api/notification/*` is deliberately **not** routed: it is an internal endpoint that only commerce-service calls inside the cluster.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | listen port | `3000` |
| `BASE_API_URL` | path prefix, must match every service | `api` |
| `IDENTITY_URL`, `CATALOG_URL`, `COMMERCE_URL`, `NOTIFICATION_URL` | backend base URLs (in Kubernetes `http://<service>:<port>`) | `http://localhost:3101` … `3104` |
| `CORS_ORIGINS` | comma-separated browser origins allowed to call the API (empty = any, local only) | empty |
| `LOG_LEVEL` | `trace` … `silent` | `info` |

## Run and test

```bash
npm ci
cp .env.example .env      # adjust the backend URLs
npm run dev               # or: npm start
npm test                  # Jest with a 100 % coverage gate
```

The tests start fake HTTP backends (and one real Socket.IO server) and point the gateway at them. To run the whole shop locally, use the Docker Compose setup in `platform-deployments/local`.

## Container and operations

```bash
docker build -t api-gateway-service:local .     # multi-stage, non-root, npm removed from the runtime image
```

| Endpoint | Used by | Meaning |
|---|---|---|
| `GET /health` | liveness probe | the process is alive |
| `GET /ready` | readiness probe | ready for traffic |
| `GET /api/health` | Cloudflare load balancer | **deep check**: asks every backend's `/ready`; `503` if any is down, so traffic moves to another cloud |
| `GET /metrics` | Prometheus | request rate, errors, latency (`http_request_duration_seconds`) + process metrics |

* JSON logs on stdout; `Authorization` and `Cookie` headers are redacted.
* Graceful shutdown on `SIGTERM` (finishes in-flight requests) for zero-downtime rolling updates.
* CORS is decided only here (`CORS_ORIGINS`); CORS headers from backends are stripped.

## CI/CD

Pull requests: tests, gitleaks, Docker build + Trivy scan. Merges to `main`: the image `api-gateway-service:main-<sha>` is pushed to ECR, ACR and Artifact Registry and Jenkins deploys it to GCP → Azure → AWS. Details: [CI/CD chapter of the handbook](https://github.com/ppmcad16a-cloud-platform/core-cloud-platform/blob/main/docs/06-ci-cd.md).
