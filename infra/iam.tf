resource "aws_iam_role" "codebuild" {
  for_each = var.environments
  name     = "${local.names[each.key]}-build"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "codebuild.amazonaws.com" }
    }]
  })
}

# Build only: logs + this pipeline's artifact prefix. No deploy permissions.
resource "aws_iam_role_policy" "codebuild" {
  for_each = var.environments
  role     = aws_iam_role.codebuild[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.codebuild[each.key].arn}:*"
      },
      {
        Effect   = "Allow", Action = ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:ListBucket"]
        Resource = aws_s3_bucket.artifacts.arn
      },
      {
        Effect   = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/${local.artifact_prefix[each.key]}/*"
      }
    ]
  })
}

# CodeDeploy service role. AWSCodeDeployRole is AWS's standard EC2/on-prem
# service policy (tag lookups, instance health); scoped custom policies for it
# break silently when AWS adds calls.
resource "aws_iam_role" "codedeploy" {
  name = "${var.project_name}-codedeploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "codedeploy.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRole"
}

resource "aws_iam_role" "pipeline" {
  for_each = var.environments
  name     = "${local.names[each.key]}-pipeline"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "codepipeline.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "pipeline" {
  for_each = var.environments
  role     = aws_iam_role.pipeline[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["codeconnections:UseConnection", "codestar-connections:UseConnection"]
        Resource = local.connection_arn
      },
      {
        Effect   = "Allow", Action = ["s3:GetBucketVersioning", "s3:GetBucketLocation", "s3:GetBucketAcl"]
        Resource = aws_s3_bucket.artifacts.arn
      },
      {
        Effect   = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/${local.artifact_prefix[each.key]}/*"
      },
      {
        Effect   = "Allow", Action = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"]
        Resource = aws_codebuild_project.build[each.key].arn
      },
      {
        Effect   = "Allow"
        Action   = ["codedeploy:GetApplication", "codedeploy:GetApplicationRevision", "codedeploy:RegisterApplicationRevision"]
        Resource = aws_codedeploy_app.api[each.key].arn
      },
      {
        Effect   = "Allow", Action = ["codedeploy:CreateDeployment", "codedeploy:GetDeployment"]
        Resource = aws_codedeploy_deployment_group.api[each.key].arn
      },
      {
        Effect   = "Allow", Action = "codedeploy:GetDeploymentConfig"
        Resource = "arn:aws:codedeploy:${var.aws_region}:${local.account_id}:deploymentconfig:${aws_codedeploy_deployment_group.api[each.key].deployment_config_name}"
      }
    ]
  })
}
