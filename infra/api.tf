# ---------------- Lambda API (backend/src/lambda.ts, đóng gói bằng `npm run build -w backend`) ----------------
data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/lambda"
  output_path = "${path.module}/build/api.zip"
}

resource "aws_iam_role" "api" {
  name = "${local.name_prefix}-api-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

# Least privilege (T15.5): chỉ bảng core + GSI, chỉ log group của chính hàm.
resource "aws_iam_role_policy" "api" {
  name = "api-access"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CoreTable"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:ConditionCheckItem",
        ]
        Resource = [data.aws_dynamodb_table.core.arn, "${data.aws_dynamodb_table.core.arn}/index/*"]
      },
      {
        # Ảnh tin đăng: chỉ prefix listings/ của bucket ảnh nhóm dựng sẵn (presigned POST + GET).
        Sid      = "ListingImages"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:PutObjectTagging", "s3:GetObjectTagging", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.image_bucket}/listings/*"
      },
      {
        # AI phân tích ảnh: Claude Haiku qua inference profile global (giaiphap E7)
        Sid    = "Bedrock"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${var.ai_model_id}",
          "arn:aws:bedrock:*::foundation-model/*",
        ]
      },
      {
        # Kiểm duyệt ảnh nhạy cảm (M6). Rekognition đọc ảnh S3 bằng quyền s3:GetObject ở trên.
        Sid      = "Moderation"
        Effect   = "Allow"
        Action   = ["rekognition:DetectModerationLabels"]
        Resource = "*"
      },
      {
        # Lambda tự gọi chính nó dạng async để chạy AI nền (QĐ-13)
        Sid      = "SelfInvoke"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.name_prefix}-api"
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = 7 # dev 7 ngày, prod 30 ngày (giaiphap E10)
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name_prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 512
  timeout          = 60 # worker AI cần thời gian; API Gateway vẫn cắt request đồng bộ ở 29 giây

  environment {
    variables = {
      STAGE             = "aws"
      AUTH_MODE         = "cognito"
      TABLE_NAME        = data.aws_dynamodb_table.core.name
      IMAGE_BUCKET      = var.image_bucket
      AI_MODEL_ID       = var.ai_model_id
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
}

# ---------------- API Gateway HTTP API + JWT authorizer (Cognito) ----------------
resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [local.web_origin, var.local_dev_origin]
    allow_methods = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type", "idempotency-key"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = local.cognito_issuer
    audience = [aws_cognito_user_pool_client.web.id]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# Mọi route cần JWT (webhook ngân hàng đã bỏ cùng nạp / rút tiền).
resource "aws_apigatewayv2_route" "authed" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "ANY /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# Preflight CORS: trình duyệt không gửi token cho OPTIONS → route riêng không qua JWT authorizer.
# Lambda trả 204, API Gateway gắn header CORS theo cors_configuration (origin lạ không được cho phép).
resource "aws_apigatewayv2_route" "preflight" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "OPTIONS /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# ---------------- Job nền (Epic 10): EventBridge gọi Lambda 15 phút/lần ----------------
resource "aws_cloudwatch_event_rule" "sweep" {
  name                = "${local.name_prefix}-sweep"
  description         = "ReLoop: hết hạn tin, nhắc 24h, tự hoàn tất 48h"
  schedule_expression = "rate(15 minutes)"
}

resource "aws_cloudwatch_event_target" "sweep" {
  rule = aws_cloudwatch_event_rule.sweep.name
  arn  = aws_lambda_function.api.arn
}

resource "aws_lambda_permission" "sweep" {
  statement_id  = "AllowEventBridgeSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweep.arn
}
