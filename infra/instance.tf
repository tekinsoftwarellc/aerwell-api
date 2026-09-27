# The instance already exists (the shared Everhaus dev box). These are READ-ONLY
# lookups: Terraform never creates, modifies or replaces it.
#
# The plan principal (IAM user alfred) may call ec2:DescribeInstances but not
# ec2:DescribeInstanceTypes (which data "aws_instance" needs) nor any IAM read,
# so both checks are DescribeInstances filters.

# The id, the CodeDeploy tag and the attached instance profile must all match.
data "aws_instances" "target" {
  for_each             = var.environments
  instance_state_names = ["running", "stopped"]
  instance_tags        = { (each.value.deploy_tag_key) = each.value.deploy_tag_value }
  filter {
    name   = "instance-id"
    values = [each.value.instance_id]
  }
  filter {
    name   = "iam-instance-profile.arn"
    values = ["arn:aws:iam::${local.account_id}:instance-profile/${each.value.instance_profile_name}"]
  }
  lifecycle {
    postcondition {
      condition     = self.ids == tolist([each.value.instance_id])
      error_message = "Instance ${each.value.instance_id} is missing, lacks the tag ${each.value.deploy_tag_key}=${each.value.deploy_tag_value}, or does not have instance profile ${each.value.instance_profile_name} attached."
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

# The CodeDeploy agent on the box fetches revisions with the instance role. The
# plan principal cannot read that role's policies, so whether it already can read
# this bucket is unknown: add one inline policy for this pipeline's prefix only.
# Terraform owns only this named policy, never the role itself. The artifact
# bucket is SSE-S3, so no KMS grant is needed.
resource "aws_iam_role_policy" "instance_artifacts" {
  for_each = var.environments
  name     = "${local.names[each.key]}-codedeploy-artifacts"
  role     = coalesce(each.value.instance_role_name, each.value.instance_profile_name)
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "CodeDeployAgentRevisions", Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource = "${aws_s3_bucket.artifacts.arn}/${local.artifact_prefix[each.key]}/*"
    }]
  })
  depends_on = [data.aws_instances.target]
}
