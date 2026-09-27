terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Credentials are resolved by the AWS provider's runtime credential chain.
# Never pass access keys through Terraform variables.
provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge(var.tags, { Project = var.project_name, ManagedBy = "Terraform" })
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id     = data.aws_caller_identity.current.account_id
  names          = { for env, config in var.environments : env => "${var.project_name}-${env}" }
  connection_arn = var.github_connection_arn != null ? var.github_connection_arn : aws_codeconnections_connection.github[0].arn
  # CodePipeline stores artifacts under the pipeline name truncated to 20 characters.
  artifact_prefix = { for env, name in local.names : env => substr(name, 0, 20) }
}
