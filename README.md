# Aerwell API

Express 4 / TypeScript / Mongo scaffold. Node 22 or later. Staff authentication is standalone: local bcrypt credentials, Aerwell HS256 access tokens, opaque rotating refresh tokens, email verification and password recovery. Staff credentials issued by any other application are never accepted.

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

The development seed requires `AERWELL_ORG_ID` and all four `SEED_SUPER_ADMIN_*` variables named in `.env.example`. It creates local bcrypt credentials from `SEED_SUPER_ADMIN_PASSWORD`; no Alfred account is needed. Run `npm run seed:dev -- --confirm-local-seed` only against localhost MongoDB in a non-production environment. It inserts default roles, organization settings, a Las Vegas location, two environments and a supplied super admin. Re-running preserves existing edits and deactivated accounts. It is never run by deployment hooks.

Deployment scaffolding uses `/home/ubuntu/aerwell-api`, PM2 `aerwell-api`, and port 3003. Hooks never source shell environment files. Configure the shared EC2 reverse proxy so it replaces forwarded client headers (Express trusts one proxy hop). Verify the existing EC2 CodeDeploy tag (see `infra/`) before deploying the CloudFormation stack; this default is inherited from the sibling template, not verified against AWS. Atlas, DNS/reverse proxy routing, CodeStar connection, and pipeline creation require separate setup and approval. No production service is configured or deployed by this repository's local scaffold.

Direct package versions match the sibling API's `package-lock.json`; this includes TypeScript 5.9.3 (the plan's prose referred to 5.6). `@vitest/coverage-v8` 4.0.18 is added to match Vitest because the sibling lock omits a coverage provider. Cache is memory-only and reserved for infrastructure counters and tokens; never cache PHI.

Staff authentication requires an independent `STAFF_JWT_SECRET` of at least 32 characters and `AERWELL_ORG_ID`. Generate and store the secret outside source control. Never reuse another application's secrets. Missing authentication configuration returns 503; there is no fallback key. Email verification and recovery require `AWS_REGION`, `SES_FROM_EMAIL` and `ADMIN_BASE_URL`; no external email is sent by tests. Recovery always returns a generic acceptance response, including when delivery is unconfigured. The login endpoint fails closed if required OTP delivery is unavailable.

The optional Alfred member/service integration uses the merged Alfred API. When enabling it, retain `ALFRED_AUTH_URL=https://api-alfred.tekinsoftware.com`, `ALFRED_AUTH_JWKS_URL=https://api-alfred.tekinsoftware.com/.well-known/jwks.json`, and `ALFRED_API_INTERNAL_URL=https://api-alfred.tekinsoftware.com` (origin only), with the existing client credentials, scopes, audiences, and `alfred-auth` issuer. Keep these settings absent while the integration is disabled. Confirm readiness and OAuth/JWKS verification on the merged backend before updating runtime configuration. Aerwell staff login and Aerwell Admin continue to use their local API.

Local routes: `POST /api/v1/auth/login`, `/refresh`, `/logout`, `/2fa/verify`, `/forgot-password`, `/reset-password`, `/change-password`. `GET /api/v1/me`, `/me/counters`, `/permissions/modules` require a local active session. Access tokens live 15 minutes; sessions expire after 30 days. Refresh rotates atomically; reusing an old refresh token revokes its session. Every authenticated request checks current staff status, credential version and session revocation. Password change/reset revokes every session. No local JWT is accepted by Alfred; future Alfred member-service calls use separate service credentials.
