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

  # Tier STANDARD: hỗ trợ nhiều ngôn ngữ (Classic chỉ bắt được câu lệnh tấn công tiếng Anh — đã thử 2026-10-19).
  # Standard bắt buộc chạy liên vùng qua guardrail profile APAC.
  cross_region_config {
    guardrail_profile_identifier = "arn:aws:bedrock:${var.region}:${local.account_id}:guardrail-profile/apac.guardrail.v1:0"
  }

  content_policy_config {
    tier_config {
      tier_name = "STANDARD"
    }
    # Các nhóm hỗ trợ lọc ẢNH
    dynamic "filters_config" {
      for_each = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS"]
      content {
        type              = filters_config.value
        input_strength    = "HIGH"
        output_strength   = "HIGH"
        input_modalities  = ["TEXT", "IMAGE"]
        output_modalities = ["TEXT"]
      }
    }
    # MISCONDUCT không hỗ trợ ảnh (Bedrock trả ValidationException) → chỉ lọc chữ
    filters_config {
      type              = "MISCONDUCT"
      input_strength    = "HIGH"
      output_strength   = "HIGH"
      input_modalities  = ["TEXT"]
      output_modalities = ["TEXT"]
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
