output "deployments" {
  description = "Deployment details by environment, plus what the box .env must contain (names and public origins only)."
  value = {
    for env, config in var.environments : env => {
      branch            = config.branch
      pipeline          = aws_codepipeline.api[env].name
      codedeploy_app    = aws_codedeploy_app.api[env].name
      deployment_group  = aws_codedeploy_deployment_group.api[env].deployment_group_name
      target            = "${config.deploy_tag_key}=${config.deploy_tag_value} (${config.instance_id})"
      instance_role     = data.aws_iam_instance_profile.target[env].role_name
      box_env_expects   = "CORS_ORIGIN includes ${config.admin_origin}; ADMIN_BASE_URL=${config.admin_origin}"
      health_check_path = "/api/v1/health and /api/v1/health/ready on port 3003"
    }
  }
}

output "instance_policy_json" {
  description = "Policy to attach to the instance role (or the app's real principal after verifying it). Terraform attaches nothing."
  value       = local.instance_policy
}

output "github_connection_arn" {
  value = local.connection_arn
}

output "github_connection_requires_authorization" {
  value = var.github_connection_arn == null
}
