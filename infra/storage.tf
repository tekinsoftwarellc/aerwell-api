# Pipeline artifacts only. SSE-S3 (not KMS) so the CodeDeploy agent can read
# revisions with s3:GetObject alone; same settings as aerwell-admin.
resource "aws_s3_bucket" "artifacts" {
  bucket        = "${var.project_name}-pipeline-${local.account_id}-${var.aws_region}"
  force_destroy = var.force_destroy_buckets
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket     = aws_s3_bucket.artifacts.id
  depends_on = [aws_s3_bucket_versioning.artifacts]
  rule {
    id     = "old-versions-and-incomplete-uploads"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# App uploads (clinical documents, service images). The app presigns PUTs with
# x-amz-server-side-encryption=AES256 and rejects anything else on verify, so this
# bucket is SSE-S3, not KMS. The browser uploads straight to S3 from the admin.
resource "aws_s3_bucket" "uploads" {
  for_each      = var.environments
  bucket        = "${local.names[each.key]}-uploads-${local.account_id}-${var.aws_region}"
  force_destroy = var.force_destroy_buckets
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  for_each                = var.environments
  bucket                  = aws_s3_bucket.uploads[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "uploads" {
  for_each = var.environments
  bucket   = aws_s3_bucket.uploads[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  for_each = var.environments
  bucket   = aws_s3_bucket.uploads[each.key].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# The app never deletes or overwrites (random keys); versioning keeps an
# accidental delete of a clinical document recoverable.
resource "aws_s3_bucket_versioning" "uploads" {
  for_each = var.environments
  bucket   = aws_s3_bucket.uploads[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  for_each   = var.environments
  bucket     = aws_s3_bucket.uploads[each.key].id
  depends_on = [aws_s3_bucket_versioning.uploads]
  rule {
    id     = "incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  for_each = var.environments
  bucket   = aws_s3_bucket.uploads[each.key].id
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = [each.value.admin_origin]
    allowed_headers = ["content-type", "x-amz-server-side-encryption"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "uploads" {
  for_each = var.environments
  bucket   = aws_s3_bucket.uploads[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.uploads[each.key].arn, "${aws_s3_bucket.uploads[each.key].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.uploads]
}
