terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state backend with DynamoDB locking (ARCH §12.2, ROADMAP §2.3)
  # To enable remote state, provide backend configuration during initialization:
  #   terraform init -backend-config="bucket=YOUR_BUCKET" -backend-config="dynamodb_table=YOUR_TABLE"
  # Or uncomment the backend block below.
  # backend "s3" {
  #   bucket         = "synapsestate-terraform-state"
  #   key            = "production/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "synapsestate-terraform-locks"
  #   encrypt        = true
  # }
}
