# Aerwell API

W0 Express 4 / TypeScript / Mongo scaffold. Node 22 or later. Authentication and staff features begin in W1.

```sh
npm ci
NODE_ENV=development MONGODB_URI=mongodb://127.0.0.1:27017/aerwell npm run dev
```

The API defaults to port 3003 and allows `http://localhost:3200`. Configure a separate Aerwell database. `.env.example` lists names only; omit optional or defaulted settings rather than assigning blank strings. Production must set `NODE_ENV=production`, an explicit `CORS_ORIGIN`, and `MONGODB_URI` in the application's own `.env`.

Health routes: `/api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready`. Readiness returns 503 when Mongo is disconnected. Swagger UI is at `/api-docs/` outside production. Errors consistently return `{ success, status, code, message, data, statusCode }`.

```sh
npm run typecheck && npm run lint && npm test && npm run build
npm run test:coverage
npm run smoke
```

Tests use isolated in-memory MongoDB processes and do not load `.env`. The smoke launches the compiled server against another memory Mongo, calls health with curl, and checks graceful shutdown. Test tooling requires downloading a MongoDB binary once.

Deployment scaffolding uses `/home/ubuntu/aerwell-api`, PM2 `aerwell-api`, and port 3003. Hooks never source shell environment files. Configure the shared EC2 reverse proxy so it replaces forwarded client headers (Express trusts one proxy hop). Verify the existing EC2 `CodeDeploy=everhaus-api-dev` tag before deploying the CloudFormation stack; this default is inherited from the sibling template, not verified against AWS. Atlas, DNS/reverse proxy routing, CodeStar connection, and pipeline creation require separate setup and approval. No production service is configured or deployed by this repository's local scaffold.

Direct package versions match `everhaus-api-new/package-lock.json`; this includes TypeScript 5.9.3 (the plan's prose referred to 5.6). `@vitest/coverage-v8` 4.0.18 is added to match Vitest because the sibling lock omits a coverage provider. Cache is memory-only and reserved for infrastructure counters and tokens; never cache PHI.
