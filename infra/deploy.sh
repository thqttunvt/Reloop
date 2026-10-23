#!/usr/bin/env bash
# Triển khai môi trường dev: build backend → terraform apply → build + upload frontend.
# Dùng: AWS_PROFILE=reloop ./infra/deploy.sh            (cả hai)
#       AWS_PROFILE=reloop ./infra/deploy.sh frontend   (chỉ frontend)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
# Terraform chưa đọc trực tiếp phiên `aws login` → xuất credentials tạm thời ra biến môi trường.
eval "$(aws configure export-credentials --format env)"

tf() { terraform -chdir="$ROOT/infra" "$@"; }

# Key Gemini chỉ truyền qua TF_VAR_gemini_api_key (không ghi file). Không truyền → GIỮ key đang có trên Lambda,
# tránh mỗi lần deploy bị đặt lại về rỗng (biến Terraform mặc định ""). Muốn tắt Gemini: TF_VAR_gemini_api_key= (rỗng) có chủ đích.
if [ -z "${TF_VAR_gemini_api_key+x}" ]; then
  TF_VAR_gemini_api_key=$(aws lambda get-function-configuration --function-name reloop-dev-api \
    --query 'Environment.Variables.GEMINI_API_KEY' --output text 2>/dev/null || true)
  [ "$TF_VAR_gemini_api_key" = "None" ] && TF_VAR_gemini_api_key=""
  export TF_VAR_gemini_api_key
fi

if [ "${1:-all}" != "frontend" ]; then
  npm run build -w backend --prefix "$ROOT"
  tf init -input=false >/dev/null
  tf apply -input=false -auto-approve
fi

API_URL=$(tf output -raw api_url)
BUCKET=$(tf output -raw web_bucket)
DIST_ID=$(tf output -raw cloudfront_distribution_id)

VITE_API_BASE="$API_URL" \
VITE_COGNITO_DOMAIN=$(tf output -raw cognito_domain) \
VITE_COGNITO_CLIENT_ID=$(tf output -raw web_client_id) \
  npm run build -w frontend --prefix "$ROOT"

# File có hash trong tên: cache lâu; index.html: không cache để bản mới có hiệu lực ngay.
aws s3 sync "$ROOT/frontend/dist/assets" "s3://$BUCKET/assets" --delete --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$ROOT/frontend/dist/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache"
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" --query 'Invalidation.Id' --output text

echo "Web: $(tf output -raw web_url)"
echo "API: $API_URL"
