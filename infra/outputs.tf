output "api_url" {
  value = aws_apigatewayv2_api.api.api_endpoint
}

output "web_url" {
  value = local.web_origin
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "cognito_domain" {
  value = local.cognito_domain
}

output "web_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}
