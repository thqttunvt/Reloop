variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "env" {
  type    = string
  default = "dev"
}

# ---- Tài nguyên dựng sẵn trên Console (Terraform chỉ ĐỌC, không quản lý) ----
variable "core_table_name" {
  type    = string
  default = "reloop-core-table"
}

# ---- Cấu hình backend ----
variable "image_bucket" {
  description = "Bucket ảnh thiết bị (dựng sẵn trên Console); Lambda chỉ dùng prefix listings/"
  type        = string
  default     = "reloop-device-images"
}

variable "ai_model_id" {
  description = "Inference profile Bedrock cho AI phân tích ảnh. Amazon Nova Pro: model của AWS, trừ được credits, tính theo request. Để rỗng = tắt AI."
  type        = string
  default     = "apac.amazon.nova-pro-v1:0"
}

variable "billing_bank" {
  description = "Tài khoản nhận phí dịch vụ hiện trên hóa đơn tháng (QĐ-37). Để rỗng = hóa đơn ghi 'Admin gửi thông tin qua email'."
  type        = object({ bank_name = string, account_no = string, account_name = string })
  default     = { bank_name = "", account_no = "", account_name = "" }
}

variable "ai_guardrail_enabled" {
  description = "Bật Bedrock Guardrail cho mỗi lần gọi AI (lọc nội dung ảnh/chữ không phù hợp, prompt attack ở phần chữ)"
  type        = bool
  default     = true
}

variable "local_dev_origin" {
  description = "Cho phép frontend chạy local gọi API trên AWS"
  type        = string
  default     = "http://localhost:5173"
}
