terraform {
  required_version = ">= 1.10"

  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # Bucket state tạo 1 lần bằng infra/bootstrap.sh. use_lockfile = khóa state bằng S3, không cần bảng DynamoDB.
  backend "s3" {
    bucket       = "reloop-tfstate-926583575243"
    key          = "dev/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "ReLoop"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
