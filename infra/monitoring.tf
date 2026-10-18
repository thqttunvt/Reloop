# ---------------- Giám sát (T15.3): metric từ log, alarm, dashboard ----------------
variable "alarm_email" {
  description = "Email nhận cảnh báo (để rỗng = không gửi email, alarm vẫn hiện trên CloudWatch). Cần bấm xác nhận trong email AWS gửi."
  type        = string
  default     = ""
}

locals {
  metric_ns      = "ReLoop/${var.env}"
  alarm_actions  = var.alarm_email == "" ? [] : [aws_sns_topic.alarms[0].arn]
  api_dimensions = { ApiId = aws_apigatewayv2_api.api.id }
  fn_dimensions  = { FunctionName = aws_lambda_function.api.function_name }
}

resource "aws_sns_topic" "alarms" {
  count = var.alarm_email == "" ? 0 : 1
  name  = "${local.name_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Metric nghiệp vụ lấy từ log JSON có cấu trúc (backend/src/http/log.ts)
resource "aws_cloudwatch_log_metric_filter" "business" {
  for_each = {
    UnhandledErrors = "{ $.msg = \"unhandled_error\" }"
    TimerFailures   = "{ $.msg = \"timer_failed\" }"
    AiFailures      = "{ $.msg = \"ai_analysis_failed\" }"
    NotifyFailures  = "{ $.msg = \"notify_failed\" }"
    ImagesRejected  = "{ $.msg = \"image_rejected\" }"
  }
  name           = "${local.name_prefix}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = each.value
  metric_transformation {
    name          = each.key
    namespace     = local.metric_ns
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.name_prefix}-lambda-errors"
  alarm_description   = "Lambda API lỗi (exception chưa bắt / timeout) ≥ 3 lần trong 5 phút"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = local.fn_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.name_prefix}-lambda-throttles"
  alarm_description   = "Lambda bị giới hạn đồng thời"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = local.fn_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-api-5xx"
  alarm_description   = "API trả 5xx ≥ 5 lần trong 5 phút (F1: lỗi < 1%)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = local.api_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${local.name_prefix}-api-latency-p95"
  alarm_description   = "Độ trễ API p95 > 2 giây trong 10 phút (F1)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = local.api_dimensions
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "business" {
  for_each = {
    UnhandledErrors = "Lỗi hệ thống chưa xử lý trong backend"
    TimerFailures   = "Job nền (hết hạn tin / tự hoàn tất) lỗi"
    AiFailures      = "AI phân tích ảnh lỗi liên tục (Bedrock?)"
  }
  alarm_name          = "${local.name_prefix}-${each.key}"
  alarm_description   = each.value
  namespace           = local.metric_ns
  metric_name         = each.key
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = each.key == "AiFailures" ? 5 : 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.business]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-overview"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "API: số request, 4xx, 5xx"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.api.id],
            [".", "4xx", ".", "."],
            [".", "5xx", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "API: độ trễ (ms)"
          region = var.region
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.api.id, { stat = "p50" }],
            ["...", { stat = "p95" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Lambda: gọi, lỗi, throttle"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.api.function_name],
            [".", "Errors", ".", "."],
            [".", "Throttles", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Lambda: thời gian chạy (ms)"
          region = var.region
          period = 300
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.api.function_name, { stat = "p95" }],
            ["...", { stat = "Maximum" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "Nghiệp vụ: lỗi job nền / AI / thông báo, ảnh bị kiểm duyệt chặn"
          region = var.region
          stat   = "Sum"
          period = 900
          metrics = [
            [local.metric_ns, "UnhandledErrors"],
            [".", "TimerFailures"],
            [".", "AiFailures"],
            [".", "NotifyFailures"],
            [".", "ImagesRejected"],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "DynamoDB reloop-core-table: capacity tiêu thụ"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", data.aws_dynamodb_table.core.name],
            [".", "ConsumedWriteCapacityUnits", ".", "."],
            [".", "TransactionConflict", ".", ".", "Operation", "TransactWriteItems"],
          ]
        }
      },
    ]
  })
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
