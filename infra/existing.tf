# Hạ tầng nhóm đã dựng trên Console. Chỉ đọc để lấy ARN / endpoint — Terraform không sửa, không xóa.
data "aws_caller_identity" "current" {}

data "aws_dynamodb_table" "core" {
  name = var.core_table_name
}

locals {
  name_prefix    = "reloop-${var.env}"
  account_id     = data.aws_caller_identity.current.account_id
  cognito_issuer = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  cognito_domain = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
  web_origin     = "https://${aws_cloudfront_distribution.web.domain_name}"
}
