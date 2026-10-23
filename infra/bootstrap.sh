#!/usr/bin/env bash
# Chạy 1 lần cho mỗi AWS account: tạo bucket lưu Terraform state (versioning, mã hóa, chặn public).
# Dùng: AWS_PROFILE=reloop ./infra/bootstrap.sh
set -euo pipefail

REGION=ap-southeast-1
export AWS_REGION="${AWS_REGION:-$REGION}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="reloop-tfstate-${ACCOUNT_ID}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket $BUCKET đã có."
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-tagging --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=ReLoop},{Key=ManagedBy,Value=bootstrap}]'
echo "Xong: s3://$BUCKET"
