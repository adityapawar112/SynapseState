variable "aws_region" {
  description = "AWS region for provisioning resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging, development)"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the SynapseState VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the public k3s subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_zone" {
  description = "Availability zone for the public subnet"
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "EC2 instance type for single-node k3s host (ARCH §12.1)"
  type        = string
  default     = "t3.medium"
}

variable "root_volume_size" {
  description = "Root EBS volume size in gigabytes"
  type        = number
  default     = 50
}

variable "root_volume_type" {
  description = "Root EBS volume type"
  type        = string
  default     = "gp3"
}

variable "ssh_public_key" {
  description = "Optional SSH public key for k3s node operator access"
  type        = string
  default     = ""
}

variable "allowed_ssh_cidrs" {
  description = "Allowed CIDR ranges for SSH administrative access (port 22)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_k8s_api_cidrs" {
  description = "Allowed CIDR ranges for k3s Kubernetes API server access (port 6443)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "domain_name" {
  description = "Domain name for SynapseState public endpoints"
  type        = string
  default     = "synapsestate.example.com"
}

variable "dns_zone_id" {
  description = "Optional Route53 Hosted Zone ID to attach public DNS records"
  type        = string
  default     = ""
}

variable "s3_backup_bucket_name" {
  description = "Base S3 bucket name for immutable tamper-evident audit checkpoints (ARCH §8.3)"
  type        = string
  default     = "synapsestate-audit-checkpoints"
}

variable "enable_object_lock" {
  description = "Enable S3 Object Lock for write-once compliance retention (ARCH §8.3 & Invariant 7)"
  type        = bool
  default     = true
}

variable "object_lock_retention_days" {
  description = "Compliance retention period in days for audit checkpoints"
  type        = number
  default     = 365
}

variable "tags" {
  description = "Resource tags applied across all managed infrastructure"
  type        = map(string)
  default = {
    Project   = "SynapseState"
    ManagedBy = "Terraform"
  }
}
