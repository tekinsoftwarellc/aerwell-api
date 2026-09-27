# Aerwell API delivery infrastructure

Terraform for deploying this API to an **already-built EC2 instance**. It follows
the same conventions as `aerwell-admin/infra`: region `us-east-1`, the same
CodeConnections pattern, V2 queued pipelines, per-environment map, SSE-S3
artifact bucket, local state, and mock `terraform test`. It replaces the earlier
CloudFormation draft (`infra/codepipeline-ec2.yml`).

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

App dir on the box: `/home/ubuntu/aerwell-api`. Terraform **never creates, modifies
or replaces the instance**. It only reads it, and the plan fails if:

- the instance lacks the CodeDeploy tag,
- `instance_profile_name` is not the profile attached to it, or
- the tag selects any other instance too (CodeDeploy deploys to every tagged instance).

It also never writes the box `.env`. `start_server.sh` exits non-zero if
`/home/ubuntu/aerwell-api/.env` is missing, and the bundle never contains a `.env`.

## What it creates

Per environment: CodeBuild project, log group, CodeDeploy application and
deployment group (auto-rollback on `DEPLOYMENT_FAILURE` and `DEPLOYMENT_STOP_ON_REQUEST`),
pipeline, and the build and pipeline IAM roles. Shared: the artifact bucket
(private, SSE-S3, versioned, TLS-only), the CodeDeploy service role
(`AWSCodeDeployRole`), and a GitHub connection only if you pass no ARN.

IAM scope:

- The build role can use logs and its own artifact prefix only. It has no deploy permissions.
- The pipeline role can use the connection, its artifact prefix, its build project, its CodeDeploy application and group, and the deployment config.

## Instance policy (attach by hand; nothing is attached by Terraform)

`terraform output -json instance_policy_json` gives one policy per environment:

| Sid | Grants | For |
|---|---|---|
| `CodeDeployAgentRevisions` | `s3:GetObject(Version)` on this pipeline's artifact prefix | CodeDeploy agent |
| `CodeDeployAgentUpdates` | `s3:GetObject` on `aws-codedeploy-us-east-1` | CodeDeploy agent self-update |
| `AppUploads` / `AppUploadsKms` | Put/Get on `app_s3_bucket`; `kms:GenerateDataKey`/`Decrypt` on `app_kms_key_arn` (only when set) | uploads (SSE-KMS) |
| `AppEmail` | `ses:SendEmail` on `ses_identity_arns` (only when set) | invites, reset, 2FA |
| `AppTranscribeMedical` | `transcribe:StartMedicalStreamTranscription(WebSocket)` | live visits |
| `AppBedrockUsProfiles` | `bedrock:InvokeModel` on the `us.` inference profiles and their `us-*` foundation models | Alfred, next steps |

**Verify the principal first.** The CodeDeploy agent uses the instance profile. The
**app** may run as a different principal: in 2026-09 a grant went to IAM user `alfred`
while the app ran as `everhaus`. Before attaching the `App*` statements, resolve the
app's principal in-process with `sts:GetCallerIdentity` using the box env, printing
only the account and ARN. If it is not the instance role, attach the `App*`
statements to that principal instead.

```bash
terraform -chdir=infra output -json instance_policy_json | python3 -c 'import json,sys; print(json.load(sys.stdin)["dev"])' > /tmp/aerwell-api-dev-instance.json
aws iam put-role-policy --role-name "$(terraform -chdir=infra output -json deployments | python3 -c 'import json,sys; print(json.load(sys.stdin)["dev"]["instance_role"])')" \
  --policy-name aerwell-api-dev --policy-document file:///tmp/aerwell-api-dev-instance.json
```

## [USER] prerequisites (before the first apply / pipeline run)

1. Create the private GitHub repo `tekinsoftwarellc/aerwell-api` and push `dev`
   (with this `infra/`, `appspec.yml`, `buildspec.yml`, `scripts/`). Authorize the
   existing CodeConnections connection for that repo, and pass its ARN.
2. Confirm the instance id, its instance profile name, and its **live** CodeDeploy tag.
   The default `CodeDeploy=everhaus-api-dev` was never verified. Check with
   `aws ec2 describe-tags --filters Name=resource-id,Values=<instance-id>`.
3. Install and run the CodeDeploy agent on the instance: `systemctl status codedeploy-agent`.
4. Install Node 22 and pm2 on the box for user `ubuntu` (the hooks run `npm` and `pm2` as `ubuntu`).
5. Create `/home/ubuntu/aerwell-api/.env` (owner `ubuntu`, mode 600) from `.env.example`.
   See `aerwell-spec/DEPLOY-RUNBOOK.md` §2.2 for the key names. It must have:
   - `CORS_ORIGIN` including `https://d2p9e00qusbm7d.cloudfront.net`
   - `ADMIN_BASE_URL=https://d2p9e00qusbm7d.cloudfront.net`
   - `PORT=3003`, because the health check probes 3003

   Never print it. The only allowed check is `grep -c '^NAME=' /home/ubuntu/aerwell-api/.env`.
6. Attach the instance policy above, after verifying the app's principal.
7. On the database, run `npm run db:sync-indexes` by hand once before the first pipeline
   run against an existing database (runbook §3). A fresh database does not need it.
8. Deploy outside visit hours. The first deploy after W11 does not drain.

## Plan / apply (the user runs these; nothing here has been applied)

Run from the repo root. Use AWS credentials from your shell or `AWS_PROFILE`, never
from Terraform variables. The account is the one aerwell-admin uses.

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars   # git-ignored; fill in the REPLACE_ME values
terraform -chdir=infra init
terraform -chdir=infra plan -out=deploy.tfplan
terraform -chdir=infra apply deploy.tfplan
terraform -chdir=infra output deployments
```

The pipeline starts once on creation. It fails at Source until the repo exists and the
connection is authorized; retry it after that. Terraform is not run by the pipeline.
Changes to branch mappings, tags or IAM need another plan/apply.

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
- that only `us.` Bedrock profiles are allowed,
- that the plan refuses an untagged or ambiguous target.

The Python tests run `start_server.sh` against stub `npm`/`pm2`. They check that a
missing `.env` fails before anything runs, that indexes sync before pm2 starts, that
pm2 runs one instance with a 50 s kill timeout, and that no hook sources or writes the `.env`.

## Rollback and teardown

- **Rollback:** revert on `dev` and push, or let CodeDeploy's auto-rollback redeploy
  the last good revision. `db:sync-indexes` never drops an index.
- **Teardown:** set `force_destroy_buckets = true`, apply, then run `destroy`. The
  instance is not managed here and is untouched.
