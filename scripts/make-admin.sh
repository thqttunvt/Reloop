#!/usr/bin/env bash
# Cấp quyền Admin cho một tài khoản (T1.5, giaiphap C16 — không có API cấp quyền Admin).
# Dùng:  AWS_PROFILE=reloop bash scripts/make-admin.sh <email-hoặc-username> [--finance]
#   --finance: thêm cả group FinanceAdmins (quyền tài chính, TL-05)
# Người được cấp phải đăng xuất rồi đăng nhập lại để token có group mới.
# Email của Admin được đăng ký nhận cảnh báo (tranh chấp mới, lỗi hệ thống…) qua SNS — cần bấm link xác nhận AWS gửi.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export MSYS_NO_PATHCONV=1

WHO="${1:?Thiếu email hoặc username}"
TF="terraform -chdir=$(dirname "$0")/../infra"
POOL_ID=$($TF output -raw user_pool_id)

# Pool dùng alias email → tìm username thật theo email nếu cần
USERNAME=$(aws cognito-idp list-users --user-pool-id "$POOL_ID" --filter "email = \"$WHO\"" --query 'Users[0].Username' --output text)
[ "$USERNAME" = "None" ] && USERNAME="$WHO"

aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" --group-name Admins
echo "Đã thêm $USERNAME vào Admins"
if [ "${2:-}" = "--finance" ]; then
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" --group-name FinanceAdmins
  echo "Đã thêm $USERNAME vào FinanceAdmins"
fi

# Đăng ký email Admin nhận cảnh báo (mục 7 danhgia) — bỏ qua nếu đã đăng ký
EMAIL=$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$USERNAME" --query "UserAttributes[?Name=='email'].Value | [0]" --output text)
TOPIC_ARN=$($TF output -raw alarm_topic_arn)
if [ -z "$EMAIL" ] || [ "$EMAIL" = "None" ]; then
  echo "⚠ Tài khoản chưa có email — không đăng ký nhận cảnh báo"
elif [ "$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query "length(Subscriptions[?Endpoint=='$EMAIL'])" --output text)" != "0" ]; then
  echo "$EMAIL đã đăng ký nhận cảnh báo"
else
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  echo "Đã đăng ký $EMAIL nhận cảnh báo — hãy mở email \"AWS Notification - Subscription Confirmation\" và bấm Confirm subscription"
fi
