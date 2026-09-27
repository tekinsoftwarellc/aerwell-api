variable "aws_region" {
  description = "AWS region of the pipeline, CodeDeploy and the existing instance. Matches aerwell-admin."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "aerwell-api"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.project_name))
    error_message = "Use 3–24 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "github_repository" {
  description = "Case-sensitive GitHub owner/repository, without URL or .git suffix."
  type        = string
  default     = "tekinsoftwarellc/aerwell-api"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository)) && !endswith(var.github_repository, ".git")
    error_message = "Provide owner/repository without a URL or .git suffix."
  }
}

variable "github_connection_arn" {
  description = "Existing AVAILABLE GitHub connection ARN in the pipeline region (the one aerwell-admin uses). Null creates a connection requiring console authorization."
  type        = string
  default     = null
  validation {
    condition     = var.github_connection_arn == null ? true : can(regex("^arn:[^:]+:(codeconnections|codestar-connections):[^:]+:[0-9]{12}:connection/.+$", var.github_connection_arn))
    error_message = "Provide a CodeConnections/CodeStar Connections connection ARN or null."
  }
}

variable "environments" {
  description = <<-EOT
    One pipeline + CodeDeploy group per key, deploying to an EXISTING instance.
    Terraform only reads the instance (data sources); it never creates or replaces it.
    The deployment group targets the tag; the plan fails unless exactly that one
    running instance carries it. app_* values scope the instance policy document.
  EOT
  type = map(object({
    branch                = string
    instance_id           = string
    instance_profile_name = string
    deploy_tag_key        = optional(string, "CodeDeploy")
    deploy_tag_value      = optional(string, "everhaus-api-dev")
    admin_origin          = optional(string, "https://d2p9e00qusbm7d.cloudfront.net")
    app_s3_bucket         = optional(string)
    app_kms_key_arn       = optional(string)
    ses_identity_arns     = optional(list(string), [])
    bedrock_model_ids     = optional(list(string), ["us.anthropic.claude-haiku-4-5", "us.anthropic.claude-sonnet-5"])
  }))
  validation {
    condition = length(var.environments) > 0 && alltrue([
      for name, config in var.environments : can(regex("^[a-z][a-z0-9-]{0,11}$", name)) && length(trimspace(config.branch)) > 0
    ])
    error_message = "Provide at least one environment; names must be 1–12 lowercase letters/digits/hyphens and branches must be nonempty."
  }
  validation {
    condition     = alltrue([for config in values(var.environments) : can(regex("^i-[0-9a-f]{8,17}$", config.instance_id))])
    error_message = "instance_id must be an EC2 instance id (i-...)."
  }
  validation {
    condition     = alltrue([for config in values(var.environments) : can(regex("^https://[^/,*]+$", config.admin_origin))])
    error_message = "admin_origin must be one https origin with no path, comma or wildcard."
  }
  validation {
    condition     = alltrue(flatten([for config in values(var.environments) : [for id in config.bedrock_model_ids : startswith(id, "us.")]]))
    error_message = "Bedrock model ids must be us. inference profiles (BAA)."
  }
}

variable "force_destroy_buckets" {
  description = "Allow terraform destroy to delete artifact bucket contents, including versions. Enable only for intentional teardown."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
