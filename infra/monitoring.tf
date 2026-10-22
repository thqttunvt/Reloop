# ---------------- Giám sát (T15.3): metric từ log, alarm, dashboard ----------------
variable "alarm_email" {
  description = "Email nhận cảnh báo thêm (không bắt buộc). Email của Admin được đăng ký tự động bằng scripts/make-admin.sh. Cần bấm xác nhận trong email AWS gửi."
  type        = string
  default     = ""
}

locals {
  metric_ns      = "ReLoop/${var.env}"
  alarm_actions  = [aws_sns_topic.alarms.arn]
  api_dimensions = { ApiId = aws_apigatewayv2_api.api.id }
  fn_dimensions  = { FunctionName = aws_lambda_function.api.function_name }
}

# Kênh cảnh báo luôn tồn tại: scripts/make-admin.sh đăng ký email của từng Admin vào đây (mục 7 danhgia)
resource "aws_sns_topic" "alarms" {
  name = "${local.name_prefix}-alarms"
}

moved {
  from = aws_sns_topic.alarms[0]
  to   = aws_sns_topic.alarms
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

# Metric nghiệp vụ lấy từ log JSON có cấu trúc (backend/src/http/log.ts)
resource "aws_cloudwatch_log_metric_filter" "business" {
  for_each = {
    UnhandledErrors = "{ $.msg = \"unhandled_error\" }"
    TimerFailures   = "{ $.msg = \"timer_failed\" }"
    AiFailures      = "{ $.msg = \"ai_analysis_failed\" }"
    # Gemini lỗi / hết hạn mức → chuyển sang Bedrock (theo dõi tần suất dự phòng)
    AiFallbacks = "{ $.msg = \"ai_fallback\" }"
    # Ghi nhật ký Admin lỗi (thao tác vẫn thành công) — get.md 2.2
    AuditWriteFailed = "{ $.msg = \"audit_write_failed\" }"
    NotifyFailures  = "{ $.msg = \"notify_failed\" }"
    ImagesRejected  = "{ $.msg = \"image_rejected\" }"
    # QĐ-36: ảnh có chữ bị gắn cờ / tin phải chờ Admin duyệt
    ImagesTextFlagged = "{ $.msg = \"image_text_flagged\" }"
    ListingsFlagged   = "{ $.msg = \"listing_flagged\" }"
    TextCheckFailures = "{ $.msg = \"image_text_check_failed\" }"
    # Khiếu nại → tranh chấp mới (mục 7 danhgia): email cho Admin
    DisputesOpened = "{ $.msg = \"dispute_opened\" }"
    # QĐ-43: ảnh nghi nhạy cảm chờ duyệt / vi phạm được ghi nhận — để chỉnh ngưỡng sau khi chạy thật
    ImagesSensitiveSuspected = "{ $.msg = \"image_sensitive_suspected\" }"
    ViolationsRecorded       = "{ $.msg = \"violation_recorded\" }"
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
    AuditWriteFailed = "Không ghi được nhật ký thao tác Admin — thao tác đã chạy nhưng thiếu dòng nhật ký"
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
            [".", "ImagesTextFlagged"],
            [".", "ListingsFlagged"],
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

# Có khiếu nại / tranh chấp mới → email cho Admin trong vài phút (mục 7 danhgia).
# Alarm chỉ gửi khi chuyển OK → ALARM: nhiều khiếu nại liên tiếp trong cùng khoảng 5 phút chỉ gửi 1 email.
resource "aws_cloudwatch_metric_alarm" "disputes_opened" {
  alarm_name          = "${local.name_prefix}-dispute-opened"
  alarm_description   = "Có khiếu nại / tranh chấp mới — vào trang Admin → Tranh chấp (hoặc chuông thông báo) để xử lý trong 7 ngày (QĐ-08)"
  namespace           = local.metric_ns
  metric_name         = "DisputesOpened"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.business]
}

# Nhiều ảnh bị gắn cờ trong 1 ngày → có thể có người cố tình tấn công AI (QĐ-36)
resource "aws_cloudwatch_metric_alarm" "text_flagged_spike" {
  alarm_name          = "${local.name_prefix}-image-text-flagged-spike"
  alarm_description   = "Hơn 10 ảnh bị gắn cờ chữ bất thường trong 24 giờ — kiểm tra hàng đợi duyệt tin ở trang Admin"
  namespace           = local.metric_ns
  metric_name         = "ImagesTextFlagged"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}
