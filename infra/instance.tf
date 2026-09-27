# The instance already exists. These are READ-ONLY lookups: Terraform never
# creates, modifies or replaces it. They fail the plan on a wrong input.

data "aws_instance" "target" {
  for_each    = var.environments
  instance_id = each.value.instance_id
  lifecycle {
    postcondition {
      condition     = lookup(self.tags, each.value.deploy_tag_key, null) == each.value.deploy_tag_value
      error_message = "The instance does not carry the CodeDeploy tag ${each.value.deploy_tag_key}=${each.value.deploy_tag_value}."
    }
    postcondition {
      condition     = self.iam_instance_profile == each.value.instance_profile_name
      error_message = "instance_profile_name does not match the profile attached to the instance."
    }
  }
}

# CodeDeploy deploys to EVERY instance with the tag. Refuse to plan unless the
# tag selects exactly the one intended box.
data "aws_instances" "tagged" {
  for_each             = var.environments
  instance_state_names = ["running", "stopped"]
  instance_tags        = { (each.value.deploy_tag_key) = each.value.deploy_tag_value }
  lifecycle {
    postcondition {
      condition     = self.ids == tolist([each.value.instance_id])
      error_message = "The CodeDeploy tag must select exactly the target instance; CodeDeploy would also deploy to the others."
    }
  }
}

data "aws_iam_instance_profile" "target" {
  for_each = var.environments
  name     = each.value.instance_profile_name
}

# Policy to ATTACH to the instance role (output only; Terraform attaches nothing).
# The CodeDeploy agent uses the instance profile. The app itself may run as a
# different principal (box credential chain / .env keys): resolve it in-process
# with sts:GetCallerIdentity before granting the App* statements to anything.
locals {
  instance_policy = { for env, config in var.environments : env => jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "CodeDeployAgentRevisions", Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"]
          Resource = "${aws_s3_bucket.artifacts.arn}/${local.artifact_prefix[env]}/*"
        },
        {
          Sid      = "CodeDeployAgentUpdates", Effect = "Allow", Action = "s3:GetObject"
          Resource = "arn:aws:s3:::aws-codedeploy-${var.aws_region}/*"
        }
      ],
      config.app_s3_bucket == null ? [] : [{
        Sid      = "AppUploads", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"]
        Resource = "arn:aws:s3:::${config.app_s3_bucket}/*"
      }],
      config.app_kms_key_arn == null ? [] : [{
        Sid      = "AppUploadsKms", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = config.app_kms_key_arn
      }],
      length(config.ses_identity_arns) == 0 ? [] : [{
        Sid      = "AppEmail", Effect = "Allow", Action = "ses:SendEmail"
        Resource = config.ses_identity_arns
      }],
      [
        {
          Sid    = "AppTranscribeMedical", Effect = "Allow", Resource = "*"
          Action = ["transcribe:StartMedicalStreamTranscription", "transcribe:StartMedicalStreamTranscriptionWebSocket"]
        },
        {
          # Converse needs bedrock:InvokeModel. A us. profile routes to any US
          # region's underlying foundation model.
          Sid = "AppBedrockUsProfiles", Effect = "Allow", Action = "bedrock:InvokeModel"
          Resource = flatten([for id in config.bedrock_model_ids : [
            "arn:aws:bedrock:${var.aws_region}:${local.account_id}:inference-profile/${id}",
            "arn:aws:bedrock:us-*::foundation-model/${trimprefix(id, "us.")}*",
          ]])
        }
      ]
    )
  }) }
}
