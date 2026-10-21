# ---------------- Vòng đời ảnh (QĐ-27) trên bucket ảnh nhóm dựng sẵn ----------------
# Terraform chỉ quản lý CẤU HÌNH LIFECYCLE của bucket (không quản lý bucket). Bucket chưa có lifecycle nào
# trước đó (kiểm tra 2026-10-16), nên không ghi đè rule của ai. Prefix uploads/ của Lambda nhóm không bị đụng tới.
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = var.image_bucket

  # Ảnh upload nhưng không gắn vào tin nào (tag state=pending) → xóa sau 1 ngày
  rule {
    id     = "reloop-listing-images-unattached"
    status = "Enabled"
    filter {
      and {
        prefix = "listings/"
        tags   = { state = "pending" }
      }
    }
    expiration {
      days = 1
    }
  }

  # Ảnh tin đăng / bằng chứng điều chỉnh giá → xóa 90 ngày sau khi upload (QĐ-27, chỉnh 2026-10-22 để tiết kiệm;
  # tin mở tối đa 7 ngày nên ảnh còn ≈ 80 ngày sau khi tin kết thúc — đủ cho giao dịch, tranh chấp thông thường)
  rule {
    id     = "reloop-listing-images-retention"
    status = "Enabled"
    filter {
      prefix = "listings/"
    }
    expiration {
      days = 90
    }
  }

  rule {
    id     = "reloop-abort-incomplete-uploads"
    status = "Enabled"
    filter {
      prefix = "listings/"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
