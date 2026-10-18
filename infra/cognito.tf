# ---------------- Cognito user pool (Terraform quản lý) ----------------
# Sao theo pool dựng tay "ReLoop-user-pool" (ap-southeast-1_2msaQRyC7), khác ở chỗ:
#  - chỉ xác minh EMAIL (pool cũ xác minh cả SĐT → Cognito gửi SMS, mà account còn trong SMS sandbox
#    nên mã không tới được). SĐT vẫn bắt buộc khai, xác minh SĐT làm trong app (QĐ-09).
#  - bỏ đăng nhập bằng SĐT (alias chỉ dùng được khi SĐT đã xác minh), khôi phục mật khẩu chỉ qua email.
# Pool cũ giữ nguyên, không bị Terraform đụng tới.

resource "aws_cognito_user_pool" "main" {
  name = "${local.name_prefix}-user-pool"

  user_pool_tier      = "ESSENTIALS"
  deletion_protection = "ACTIVE"
  mfa_configuration   = "OFF"

  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length                   = 8
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD"]
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT" # giới hạn ~50 email/ngày; đổi sang SES khi demo đông người
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "ReLoop - mã xác minh tài khoản"
    email_message        = "Mã xác minh ReLoop của bạn là {####}"
  }

  # Thuộc tính bắt buộc như pool cũ (không đổi được sau khi tạo pool).
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }

  schema {
    name                = "phone_number"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }

  schema {
    name                = "address"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }

  # Dùng lại Lambda của nhóm: tạo hồ sơ USER#<sub>/PROFILE khi xác nhận đăng ký.
  lambda_config {
    post_confirmation = data.aws_lambda_function.post_confirmation.arn
  }
}

data "aws_lambda_function" "post_confirmation" {
  function_name = "reloop-auth-post-confirmation"
}

resource "aws_lambda_permission" "cognito_post_confirmation" {
  statement_id  = "AllowCognito-${local.name_prefix}-user-pool"
  action        = "lambda:InvokeFunction"
  function_name = data.aws_lambda_function.post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = "${local.name_prefix}-auth"
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 1 # Hosted UI cổ điển, giống pool cũ
}

locals {
  oauth_callback_urls = [
    "${local.web_origin}/auth/callback",
    "${var.local_dev_origin}/auth/callback",
  ]
  oauth_logout_urls = ["${local.web_origin}/", "${var.local_dev_origin}/"]
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name_prefix}-web-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH"]
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["email", "openid", "phone"]
  callback_urls                        = local.oauth_callback_urls
  logout_urls                          = local.oauth_logout_urls

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 5
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  auth_session_validity         = 3
}

resource "aws_cognito_user_pool_client" "mobile" {
  name         = "${local.name_prefix}-mobile-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH"]
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["email", "openid", "phone"]
  callback_urls                        = local.oauth_callback_urls

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 5
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  auth_session_validity         = 3
}

# Group như pool cũ. Admins → quyền admin, FinanceAdmins → admin_finance (backend/src/auth/auth.ts).
resource "aws_cognito_user_group" "groups" {
  for_each = {
    Admins        = { description = "System operators and verifiers", precedence = 1 }
    FinanceAdmins = { description = "Quản trị tài chính: duyệt STK, lệnh rút, đối soát (TL-05)", precedence = 1 }
    Partners      = { description = "Verified recycling and repair shops", precedence = 2 }
    Owners        = { description = "Device sellers", precedence = 3 }
  }

  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
  description  = each.value.description
  precedence   = each.value.precedence
}
