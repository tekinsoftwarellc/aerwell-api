output "deployments" {
  description = "Deployment details by environment, plus what the box .env must contain (names and public values only)."
  value = {
    for env, config in var.environments : env => {
      branch               = config.branch
      pipeline             = aws_codepipeline.api[env].name
      codedeploy_app       = aws_codedeploy_app.api[env].name
      deployment_group     = aws_codedeploy_deployment_group.api[env].deployment_group_name
      target               = "${config.deploy_tag_key}=${config.deploy_tag_value} (${config.instance_id})"
      instance_role_policy = "${aws_iam_role_policy.instance_artifacts[env].role}:${aws_iam_role_policy.instance_artifacts[env].name}"
      uploads_bucket       = aws_s3_bucket.uploads[env].bucket
      box_env_expects      = "PORT=3003; AWS_REGION=${var.aws_region}; AWS_S3_BUCKET=${aws_s3_bucket.uploads[env].bucket}; CORS_ORIGIN includes ${config.admin_origin}; ADMIN_BASE_URL=${config.admin_origin}"
      health_check_path    = "/api/v1/health and /api/v1/health/ready on port 3003"
    }
  }
}

# The app runs as IAM user `aerwell` (access keys in the box .env, created by
# hand). This is its policy; Terraform attaches nothing to that user.
output "aerwell_user_policy_json" {
  description = "Least-privilege policy for IAM user aerwell (the app's principal). Attach by hand."
  value       = local.aerwell_user_policy
}

output "github_connection_arn" {
  value = local.connection_arn
}

output "github_connection_requires_authorization" {
  value = var.github_connection_arn == null
}
