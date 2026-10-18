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
  description = "Inference profile Bedrock cho AI phân tích ảnh (Claude Haiku 4.5, giaiphap E7). Để rỗng = tắt AI."
  type        = string
  default     = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "local_dev_origin" {
  description = "Cho phép frontend chạy local gọi API trên AWS"
  type        = string
  default     = "http://localhost:5173"
}
