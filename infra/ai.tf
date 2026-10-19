# ---------------- Bedrock Guardrail cho AI phân tích ảnh ----------------
# Lớp bảo vệ thứ 2 sau Rekognition (kiểm duyệt khi upload). Tính tiền theo lượt kiểm tra, để không = 0đ.
# Lưu ý: bộ lọc PROMPT_ATTACK chỉ xét phần CHỮ; ảnh được lọc theo nhóm nội dung (khiêu dâm, bạo lực, thù ghét…).
# Chữ nằm trong ảnh do chỉ dẫn hệ thống + schema bắt buộc + backend validate xử lý (backend/src/ai/analyzer.ts).
resource "aws_bedrock_guardrail" "ai" {
  count                     = var.ai_guardrail_enabled ? 1 : 0
  name                      = "${local.name_prefix}-ai-guardrail"
  description               = "ReLoop: lọc ảnh / chữ không phù hợp khi AI phân tích ảnh thiết bị"
  blocked_input_messaging   = "Ảnh không phù hợp."
  blocked_outputs_messaging = "Kết quả không phù hợp."

  content_policy_config {
    dynamic "filters_config" {
      for_each = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT"]
      content {
        type              = filters_config.value
        input_strength    = "HIGH"
        output_strength   = "HIGH"
        input_modalities  = ["TEXT", "IMAGE"]
        output_modalities = ["TEXT"]
      }
    }
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
  }
}

resource "aws_bedrock_guardrail_version" "ai" {
  count         = var.ai_guardrail_enabled ? 1 : 0
  guardrail_arn = aws_bedrock_guardrail.ai[0].guardrail_arn
  description   = "managed by terraform"
}
