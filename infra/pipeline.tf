resource "aws_codeconnections_connection" "github" {
  count         = var.github_connection_arn == null ? 1 : 0
  name          = "${var.project_name}-github"
  provider_type = "GitHub"
}

resource "aws_cloudwatch_log_group" "codebuild" {
  for_each          = var.environments
  name              = "/aws/codebuild/${local.names[each.key]}-build"
  retention_in_days = 30
}

# Runs the repo-root buildspec.yml: npm ci, typecheck, lint, test, build, and
# emits the CodeDeploy bundle (dist/, package*.json, appspec.yml, scripts/).
resource "aws_codebuild_project" "build" {
  for_each      = var.environments
  name          = "${local.names[each.key]}-build"
  service_role  = aws_iam_role.codebuild[each.key].arn
  build_timeout = 30
  artifacts { type = "CODEPIPELINE" }
  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false
  }
  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec.yml"
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild[each.key].name
    }
  }
  depends_on = [aws_iam_role_policy.codebuild]
}

resource "aws_codedeploy_app" "api" {
  for_each         = var.environments
  name             = local.names[each.key]
  compute_platform = "Server"
}

resource "aws_codedeploy_deployment_group" "api" {
  for_each               = var.environments
  app_name               = aws_codedeploy_app.api[each.key].name
  deployment_group_name  = "${local.names[each.key]}-dg"
  service_role_arn       = aws_iam_role.codedeploy.arn
  deployment_config_name = "CodeDeployDefault.OneAtATime"
  deployment_style {
    deployment_type   = "IN_PLACE"
    deployment_option = "WITHOUT_TRAFFIC_CONTROL"
  }
  ec2_tag_set {
    ec2_tag_filter {
      key   = each.value.deploy_tag_key
      value = each.value.deploy_tag_value
      type  = "KEY_AND_VALUE"
    }
  }
  # Runbook: a failed index sync or health check must restore the last good revision.
  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_REQUEST"]
  }
  # data.aws_instances.tagged fails the plan unless the tag selects only this box.
  depends_on = [aws_iam_role_policy_attachment.codedeploy, data.aws_instances.tagged]
}

resource "aws_codepipeline" "api" {
  for_each       = var.environments
  name           = local.names[each.key]
  role_arn       = aws_iam_role.pipeline[each.key].arn
  pipeline_type  = "V2"
  execution_mode = "QUEUED"
  artifact_store {
    location = aws_s3_bucket.artifacts.id
    type     = "S3"
  }
  stage {
    name = "Source"
    action {
      name             = "GitHub"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      output_artifacts = ["SourceArtifact"]
      configuration = {
        ConnectionArn        = local.connection_arn
        FullRepositoryId     = var.github_repository
        BranchName           = each.value.branch
        DetectChanges        = "true"
        OutputArtifactFormat = "CODE_ZIP"
      }
    }
  }
  stage {
    name = "Build"
    action {
      name             = "Build"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceArtifact"]
      output_artifacts = ["BuildArtifact"]
      configuration    = { ProjectName = aws_codebuild_project.build[each.key].name }
    }
  }
  stage {
    name = "Deploy"
    action {
      name            = "CodeDeployToEC2"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "CodeDeploy"
      version         = "1"
      input_artifacts = ["BuildArtifact"]
      configuration = {
        ApplicationName     = aws_codedeploy_app.api[each.key].name
        DeploymentGroupName = aws_codedeploy_deployment_group.api[each.key].deployment_group_name
      }
    }
  }
  depends_on = [
    aws_iam_role_policy.pipeline,
    aws_s3_bucket_policy.artifacts,
    aws_s3_bucket_public_access_block.artifacts,
    aws_s3_bucket_server_side_encryption_configuration.artifacts,
    aws_s3_bucket_versioning.artifacts
  ]
}
