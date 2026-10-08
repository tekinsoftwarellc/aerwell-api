# Aerwell API

Aerwell operational API for staff, services, appointments, visits, clinical workflows and partner fulfilment. Staff authentication is independent of Alfred.

[Workspace docs](../../docs/README.md) · [Product behavior](../../docs/features/aerwell.md) · [Current work](../../docs/status.md)

## Local development

Use Node 22 or later (follow package/build requirements for the selected branch).

```sh
npm ci
npm run dev
```

Configure required values before starting. Never commit runtime secrets or print `.env` content.

## Configuration and behavior

Local defaults are port 3003 and Admin origin `http://localhost:3200`. Use a separate Aerwell database. `.env.example` and `src/config/env.ts` define settings; omit optional values rather than inserting blank strings. Keep `STAFF_JWT_SECRET` independent and at least 32 characters; set `AERWELL_ORG_ID`.

Staff use bcrypt credentials, HS256 access tokens and rotating opaque refresh tokens. Authenticated requests verify current staff/session state; password change/reset revokes sessions. No Aerwell staff JWT is accepted by Alfred. SES verification/recovery needs `AWS_REGION`, `SES_FROM_EMAIL` and `ADMIN_BASE_URL`; missing required OTP delivery blocks login.

Optional Alfred member/service integration uses `https://api-alfred.tekinsoftware.com` for `ALFRED_AUTH_URL` and `ALFRED_API_INTERNAL_URL`, plus its `/.well-known/jwks.json` for `ALFRED_AUTH_JWKS_URL`. Preserve service credentials, scopes, audiences and issuer `alfred-auth`. Keep disabled integration settings absent.

Health endpoints are `/api/v1/health`, `/health/live`, `/health/ready`; readiness is 503 without Mongo. Swagger is `/api-docs/` outside production. The envelope contains `success`, `status`, `code`, `message`, `data`, `statusCode`.

The development seed is explicitly local-only: it requires the documented `SEED_SUPER_ADMIN_*` inputs and `--confirm-local-seed`. It is never a deployment hook. Tests use isolated in-memory MongoDB. See [infra](infra/README.md) for deploy hooks and [current product](../../docs/features/aerwell.md) for capabilities.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Run the exact relevant buildspec gates before release. Current checkouts may lag the recorded dev ref; verify branch and dirty state first. Runtime deployment and external acceptance are tracked separately in [current work](../../docs/status.md).
