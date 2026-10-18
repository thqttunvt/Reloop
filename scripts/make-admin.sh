#!/usr/bin/env bash
# Cấp quyền Admin cho một tài khoản (T1.5, giaiphap C16 — không có API cấp quyền Admin).
# Dùng:  AWS_PROFILE=reloop bash scripts/make-admin.sh <email-hoặc-username> [--finance]
#   --finance: thêm cả group FinanceAdmins (quyền tài chính, TL-05)
# Người được cấp phải đăng xuất rồi đăng nhập lại để token có group mới.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export MSYS_NO_PATHCONV=1

WHO="${1:?Thiếu email hoặc username}"
POOL_ID=$(terraform -chdir="$(dirname "$0")/../infra" output -raw user_pool_id)

# Pool dùng alias email → tìm username thật theo email nếu cần
USERNAME=$(aws cognito-idp list-users --user-pool-id "$POOL_ID" --filter "email = \"$WHO\"" --query 'Users[0].Username' --output text)
[ "$USERNAME" = "None" ] && USERNAME="$WHO"

aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" --group-name Admins
echo "Đã thêm $USERNAME vào Admins"
if [ "${2:-}" = "--finance" ]; then
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" --group-name FinanceAdmins
  echo "Đã thêm $USERNAME vào FinanceAdmins"
fi
