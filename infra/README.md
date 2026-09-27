# Aerwell API delivery infrastructure

Terraform for deploying this API to an **already-built EC2 instance**. It follows
the same conventions as `aerwell-admin/infra`: region `us-east-1`, the same
CodeConnections connection, V2 queued pipelines, per-environment map, SSE-S3
buckets, local state, the `tf.py` launcher, and mock `terraform test`.

```text
GitHub push to the env branch (dev)
  → CodePipeline V2 (queued)
  → CodeBuild (Node 22, repo-root buildspec.yml): npm ci → typecheck → lint → test → build
  → bundle: dist/, package*.json, .env.example, appspec.yml, scripts/*.sh
  → CodeDeploy in-place to the instance tagged deploy_tag_key=deploy_tag_value
      ApplicationStop   scripts/stop_server.sh     pm2 stop (SIGINT, drains live captures)
      AfterInstall      scripts/prepare_app_dir.sh
      ApplicationStart  scripts/start_server.sh    npm ci --omit=dev → db:sync-indexes → pm2 start (1 instance, --kill-timeout=50000)
      ValidateService   scripts/validate_service.sh GET /api/v1/health + /api/v1/health/ready on :3003
  → any failure → automatic rollback to the last good revision
```

App dir on the box: `/home/ubuntu/aerwell-api`.

**Target: the shared Everhaus dev box** `i-08b21c52d96827f7d` (t3.small, Name
`Everhaus-API (dev)`, tag `CodeDeploy=everhaus-api-dev`, instance profile
`EC2-WITH-CODE-PIPELINE`, CodeDeploy agent already installed). It also runs
everhaus-api (:3000) and alfred-api (:3002) under pm2; Aerwell uses **:3003**
(alfred-auth's default :3001 is also clear). Risk: a t3.small has 2 GiB for three
Node apps, pm2 and the agent; check `free -m` and `pm2 monit` after the first deploy.

Terraform **never creates, modifies or replaces the instance**. It only reads it with
`ec2:DescribeInstances` (the plan principal, IAM user `alfred`, is denied
`ec2:DescribeInstanceTypes`, which `data "aws_instance"` needs, and all IAM reads).
The plan fails if:

- the instance id, the CodeDeploy tag and the attached instance profile
  (`instance_profile_name`, no IAM path) do not all match, or
- the tag selects any other instance too (CodeDeploy deploys to every tagged instance).

It also never writes the box `.env`. `start_server.sh` exits non-zero if
`/home/ubuntu/aerwell-api/.env` is missing, and the bundle never contains a `.env`.

## What it creates

Per environment: CodeBuild project, log group, CodeDeploy application and
deployment group (auto-rollback on `DEPLOYMENT_FAILURE` and `DEPLOYMENT_STOP_ON_REQUEST`),
pipeline, the build and pipeline IAM roles, the **uploads bucket**, and one inline
policy on the box's instance role. Shared: the artifact bucket (private, SSE-S3,
versioned, TLS-only), the CodeDeploy service role (`AWSCodeDeployRole`), and a
GitHub connection only if you pass no ARN.

IAM scope:

- The build role can use logs and its own artifact prefix only. It has no deploy permissions.
- The pipeline role can use the connection, its artifact prefix, its build project, its CodeDeploy application and group, and the deployment config.
- **Instance role** (`instance_role_name`, default = `instance_profile_name`): inline policy
  `aerwell-api-<env>-codedeploy-artifacts`, `s3:GetObject(Version)` on this pipeline's
  artifact prefix only, so the CodeDeploy agent can fetch revisions. Whether the role
  already could is unknown (IAM reads are denied to `alfred`). Terraform owns only this
  named policy, never the role. A wrong role name fails the apply with `NoSuchEntity`.

### Uploads bucket

`aerwell-api-dev-uploads-585239386213-us-east-1` (output `deployments.dev.uploads_bucket`,
goes in `AWS_S3_BUCKET`): public access blocked, SSE-S3 (the app presigns uploads with
`x-amz-server-side-encryption: AES256` and rejects anything else on verify, so not KMS),
versioned, TLS-only, CORS `PUT`/`GET`/`HEAD` from the admin origin only.

## App principal: IAM user `aerwell`

The app authenticates with access keys of IAM user **`aerwell`**, created by hand, in
the box `.env`. Terraform creates and attaches nothing for it.

1. Create user `aerwell` (no console access). Attach `infra/aerwell-user-policy.json`
   (same text as `terraform output -raw aerwell_user_policy_json`; a `check` block warns
   at plan if it no longer names the uploads bucket Terraform creates).
2. Create one access key and put `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in
   `/home/ubuntu/aerwell-api/.env`. `start_server.sh` strips inherited `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_PROFILE`, so another app's keys
   on the shared box cannot win.
3. Verify the running principal in-process (`sts:GetCallerIdentity` with the app's env,
   printing only the ARN). It must be `arn:aws:iam::585239386213:user/aerwell`.

| Sid | Grants | Used by |
|---|---|---|
| `UploadsObjects` / `UploadsList` | `s3:PutObject`, `s3:GetObject` (also HeadObject) on the bucket; `s3:ListBucket` | presigned uploads/downloads, verify |
| `Email` | `ses:SendEmail` on `identity/*` in us-east-1 | invites, reset, 2FA. The `SES_FROM_EMAIL` identity is unknown; narrow the ARN once it is. |
| `TranscribeMedicalStreaming` | `transcribe:StartMedicalStreamTranscription(WebSocket)` | live visits (the action takes no resource) |
| `BedrockUsInferenceProfiles` | `bedrock:InvokeModel(WithResponseStream)` on `us.anthropic.claude-haiku-4-5*` / `us.anthropic.claude-sonnet-5*` profiles | Converse (Alfred, next steps) |
| `BedrockFoundationModelsOnlyViaUsProfiles` | same actions on `us-*` foundation models, only when called through those profiles | cross-region routing |

The routing regions of the `us.` profiles could not be read (`bedrock:GetInferenceProfile`
is denied to `alfred`), so the foundation-model ARNs use `us-*`; the
`bedrock:InferenceProfileArn` condition keeps direct in-region invocation denied.

### Box `.env` names

Known values: `NODE_ENV=production`, `PORT=3003`, `HOST=0.0.0.0`, `AWS_REGION=us-east-1`,
`AWS_S3_BUCKET=aerwell-api-dev-uploads-585239386213-us-east-1`,
`CORS_ORIGIN=https://d2p9e00qusbm7d.cloudfront.net`,
`ADMIN_BASE_URL=https://d2p9e00qusbm7d.cloudfront.net`, `TRANSCRIBE_REGION=us-east-1`,
`BEDROCK_REGION=us-east-1`, `BEDROCK_MODEL_FAST=us.anthropic.claude-haiku-4-5…`,
`BEDROCK_MODEL_SMART=us.anthropic.claude-sonnet-5…` (exact profile ids: [USER]).

[USER] values: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (user `aerwell`), `MONGODB_URI`,
`STAFF_JWT_SECRET` (32+ chars), `AERWELL_ORG_ID`, `SES_FROM_EMAIL`, `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_MAX`; optional `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ALFRED_API_INTERNAL_URL`, `ALFRED_AUTH_URL`,
`ALFRED_AUTH_JWKS_URL`, `ALFRED_AUTH_CLIENT_ID`, `ALFRED_AUTH_CLIENT_SECRET`; seed-only
`SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`, `SEED_SUPER_ADMIN_FIRST_NAME`,
`SEED_SUPER_ADMIN_LAST_NAME`.

## [USER] prerequisites (before the first apply / pipeline run)

1. Repo `tekinsoftwarellc/aerwell-api` exists with `dev` pushed. Authorize the existing
   CodeConnections connection (the one aerwell-admin uses) for this repo.
2. **Give `alfred` apply permissions.** Its `AerwellTerraformProvisioner` policy is scoped
   to `aerwell-admin-*`, so the plan works but the apply would be denied. Attach
   `infra/policies/terraform-provisioner.json` (same shape, `aerwell-api-*`, plus CodeDeploy,
   `iam:PassRole` to CodeDeploy, and `Put/Get/DeleteRolePolicy` on `EC2-WITH-CODE-PIPELINE`)
   with admin credentials. Note: `iam:PutRolePolicy` on the box role lets `alfred` write any
   inline policy there; if that is unacceptable, remove that statement and attach
   `aws_iam_role_policy.instance_artifacts` by hand instead.
3. Confirm the role inside `EC2-WITH-CODE-PIPELINE` is named the same (else set `instance_role_name`).
4. Node 22 and pm2 for `ubuntu` on the box (already there for the other apps; check `node -v`).
5. Create IAM user `aerwell` and its key (above), then `/home/ubuntu/aerwell-api/.env`
   (owner `ubuntu`, mode 600). Never print it; the only allowed check is
   `grep -c '^NAME=' /home/ubuntu/aerwell-api/.env`.
6. On the database, run `npm run db:sync-indexes` by hand once before the first pipeline
   run against an existing database (runbook §3). A fresh database does not need it.
7. Deploy outside visit hours. The first deploy after W11 does not drain.

## Plan / apply (the user runs apply; nothing here has been applied)

Credentials come from profile `alfred-infra`, never from Terraform variables.
`infra/tf.py` (same as aerwell-admin's) loads `infra/.env` without a shell; copy
`infra/.env.example` and use the admin's `AWS_PROFILE` and `TF_VAR_github_connection_arn`.
`infra/terraform.tfvars` holds the rest (copy `terraform.tfvars.example`). Both are git-ignored.

```bash
python3 infra/tf.py init
python3 infra/tf.py plan -out=deploy.tfplan
python3 infra/tf.py apply deploy.tfplan
python3 infra/tf.py output deployments
```

The pipeline starts once on creation. It fails at Source until the connection is
authorized for the repo; retry it after that. Terraform is not run by the pipeline.

State is local (`infra/terraform.tfstate`, git-ignored). It can hold sensitive values,
so keep it private and never print it. To migrate to an S3 backend, see
`aerwell-admin/infra/README.md` and use key `aerwell-api/terraform.tfstate`.

## Validation

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false && terraform -chdir=infra validate
terraform -chdir=infra test
python3 -m unittest discover -s infra/tests -p 'test_*.py'
```

The mock tests check the plan without contacting AWS:

- the CodeDeploy target and auto-rollback,
- IAM scoping,
- that the aerwell user policy names the uploads bucket and allows Bedrock only through `us.` profiles,
- the uploads bucket (private, SSE-S3, admin-only CORS) and the instance-role inline policy,
- that the plan refuses an untagged, wrong-profile or ambiguous target.

The Python tests run `start_server.sh` against stub `npm`/`pm2`. They check that a
missing `.env` fails before anything runs, that indexes sync before pm2 starts, that
pm2 runs one instance with a 50 s kill timeout, that inherited app env and AWS
credentials never reach the index sync or pm2, and that no hook sources or writes the `.env`.

## Rollback and teardown

- **Rollback:** revert on `dev` and push, or let CodeDeploy's auto-rollback redeploy
  the last good revision. `db:sync-indexes` never drops an index.
- **Teardown:** set `force_destroy_buckets = true`, apply, then run `destroy`. The
  instance is not managed here and is untouched.
