mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock-role", name = "mock-role" }
  }
  mock_resource "aws_codebuild_project" {
    defaults = { arn = "arn:aws:codebuild:us-east-1:123456789012:project/mock-build" }
  }
  mock_resource "aws_codedeploy_app" {
    defaults = { arn = "arn:aws:codedeploy:us-east-1:123456789012:application:mock" }
  }
  mock_resource "aws_codedeploy_deployment_group" {
    defaults = { arn = "arn:aws:codedeploy:us-east-1:123456789012:deploymentgroup:mock/mock-dg" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock-group" }
  }
  mock_data "aws_caller_identity" {
    # The real account, so the committed aerwell-user-policy.json can be checked.
    defaults = { account_id = "585239386213" }
  }
  mock_data "aws_instances" {
    defaults = { ids = ["i-0123456789abcdef0"] }
  }
}

variables {
  github_connection_arn = "arn:aws:codeconnections:us-east-1:123456789012:connection/11111111-1111-1111-1111-111111111111"
  environments = {
    dev = {
      branch                = "dev"
      instance_id           = "i-0123456789abcdef0"
      instance_profile_name = "box-profile"
    }
  }
}

run "pipeline_deploys_to_existing_tagged_instance" {
  command = apply
  assert {
    condition     = length(aws_codeconnections_connection.github) == 0
    error_message = "Reusing a connection must not create another connection."
  }
  assert {
    condition     = aws_codepipeline.api["dev"].stage[0].action[0].configuration.FullRepositoryId == "tekinsoftwarellc/aerwell-api" && aws_codepipeline.api["dev"].stage[0].action[0].configuration.BranchName == "dev"
    error_message = "Source must default to tekinsoftwarellc/aerwell-api on the configured branch."
  }
  assert {
    condition     = aws_codepipeline.api["dev"].stage[2].action[0].provider == "CodeDeploy" && aws_codepipeline.api["dev"].execution_mode == "QUEUED"
    error_message = "Deploy must be CodeDeploy and executions must not race."
  }
  assert {
    condition     = aws_codebuild_project.build["dev"].source[0].buildspec == "buildspec.yml" && aws_codebuild_project.build["dev"].environment[0].image == "aws/codebuild/standard:7.0"
    error_message = "Build must use the repo buildspec on the Node 22 image."
  }
  assert {
    condition     = one(one(aws_codedeploy_deployment_group.api["dev"].ec2_tag_set).ec2_tag_filter).value == "everhaus-api-dev" && aws_codedeploy_deployment_group.api["dev"].deployment_style[0].deployment_type == "IN_PLACE"
    error_message = "The deployment group must target the tagged instance in place."
  }
  assert {
    condition     = aws_codedeploy_deployment_group.api["dev"].auto_rollback_configuration[0].enabled && contains(aws_codedeploy_deployment_group.api["dev"].auto_rollback_configuration[0].events, "DEPLOYMENT_FAILURE")
    error_message = "The runbook requires automatic rollback on deployment failure."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.codebuild["dev"].policy, "codedeploy:")
    error_message = "The build role must not have deploy permissions."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.pipeline["dev"].policy, "\"Resource\":\"*\"")
    error_message = "The pipeline role must be scoped to its own resources."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets && !aws_s3_bucket.artifacts.force_destroy
    error_message = "The artifact bucket must be private and protected on destroy."
  }
  assert {
    condition     = aws_iam_role_policy.instance_artifacts["dev"].role == "box-profile" && strcontains(aws_iam_role_policy.instance_artifacts["dev"].policy, "arn:aws:s3:::mock-bucket/aerwell-api-dev/*") && !strcontains(aws_iam_role_policy.instance_artifacts["dev"].policy, "s3:PutObject")
    error_message = "The instance role gets read-only access to this pipeline's artifact prefix, on the profile's role."
  }
  assert {
    condition     = aws_s3_bucket.uploads["dev"].bucket == "aerwell-api-dev-uploads-585239386213-us-east-1" && aws_s3_bucket_public_access_block.uploads["dev"].restrict_public_buckets && !aws_s3_bucket.uploads["dev"].force_destroy
    error_message = "The uploads bucket must be private and protected on destroy."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.uploads["dev"].rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "Uploads must be SSE-S3: the app presigns and verifies AES256."
  }
  assert {
    condition     = one(aws_s3_bucket_cors_configuration.uploads["dev"].cors_rule).allowed_origins == toset(["https://d2p9e00qusbm7d.cloudfront.net"]) && contains(one(aws_s3_bucket_cors_configuration.uploads["dev"].cors_rule).allowed_methods, "PUT")
    error_message = "Upload CORS must allow PUT from the admin origin only."
  }
  assert {
    condition = alltrue(flatten([for st in jsondecode(output.aerwell_user_policy_json).Statement : [
      for r in flatten([st.Resource]) : strcontains(r, "inference-profile/us.anthropic.") || (strcontains(r, "foundation-model/anthropic.") && can(st.Condition.StringLike["bedrock:InferenceProfileArn"]))
    ] if startswith(st.Sid, "Bedrock")]))
    error_message = "Bedrock grants must be us. profiles, and foundation models only through them."
  }
  assert {
    condition     = strcontains(output.aerwell_user_policy_json, "arn:aws:s3:::aerwell-api-dev-uploads-585239386213-us-east-1/*") && !strcontains(output.aerwell_user_policy_json, "s3:*") && !strcontains(output.aerwell_user_policy_json, "kms:")
    error_message = "The aerwell user policy must be scoped to the uploads bucket this configuration creates."
  }
  assert {
    condition     = strcontains(output.deployments["dev"].box_env_expects, "https://d2p9e00qusbm7d.cloudfront.net")
    error_message = "The admin origin must default to the deployed admin CloudFront URL."
  }
}

run "refuse_tag_that_selects_other_instances" {
  command = plan
  override_data {
    target = data.aws_instances.tagged["dev"]
    values = { ids = ["i-0123456789abcdef0", "i-0fedcba9876543210"] }
  }
  expect_failures = [data.aws_instances.tagged]
}

run "refuse_instance_without_tag_or_profile" {
  command = plan
  override_data {
    target = data.aws_instances.target["dev"]
    values = { ids = [] }
  }
  expect_failures = [data.aws_instances.target]
}

run "explicit_instance_role_name" {
  command = plan
  variables {
    environments = { dev = { branch = "dev", instance_id = "i-0123456789abcdef0", instance_profile_name = "box-profile", instance_role_name = "box-role" } }
  }
  assert {
    condition     = aws_iam_role_policy.instance_artifacts["dev"].role == "box-role"
    error_message = "instance_role_name must override the profile name."
  }
}

run "create_connection_when_missing" {
  command = plan
  variables { github_connection_arn = null }
  assert {
    condition     = length(aws_codeconnections_connection.github) == 1 && output.github_connection_requires_authorization
    error_message = "A new connection must require authorization."
  }
}
