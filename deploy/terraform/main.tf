provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      var.tags,
      {
        Environment = var.environment
        Component   = "infrastructure"
      }
    )
  }
}

# -----------------------------------------------------------------------------
# VPC & Networking Architecture (ARCH §12.1, §12.2)
# -----------------------------------------------------------------------------

resource "aws_vpc" "synapse_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "synapsestate-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "synapse_igw" {
  vpc_id = aws_vpc.synapse_vpc.id

  tags = {
    Name = "synapsestate-${var.environment}-igw"
  }
}

resource "aws_subnet" "synapse_public_subnet" {
  vpc_id                  = aws_vpc.synapse_vpc.id
  cidr_block              = var.subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name = "synapsestate-${var.environment}-public-subnet"
  }
}

resource "aws_route_table" "synapse_public_rt" {
  vpc_id = aws_vpc.synapse_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.synapse_igw.id
  }

  tags = {
    Name = "synapsestate-${var.environment}-public-rt"
  }
}

resource "aws_route_table_association" "synapse_public_rta" {
  subnet_id      = aws_subnet.synapse_public_subnet.id
  route_table_id = aws_route_table.synapse_public_rt.id
}

# -----------------------------------------------------------------------------
# Security Group & Firewall Rules (ROADMAP §2.3)
# -----------------------------------------------------------------------------

resource "aws_security_group" "synapse_k3s_sg" {
  name        = "synapsestate-${var.environment}-k3s-sg"
  description = "Security group for SynapseState single-node k3s host"
  vpc_id      = aws_vpc.synapse_vpc.id

  # Ingress: SSH management access
  ingress {
    description = "SSH administrative access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_ssh_cidrs
  }

  # Ingress: HTTP for cert-manager HTTP-01 ACME challenge & HTTP->HTTPS redirects
  ingress {
    description = "HTTP ingress (cert-manager & redirect)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Ingress: HTTPS public API & workloads ingress
  ingress {
    description = "HTTPS public ingress"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Ingress: k3s Kubernetes API server
  ingress {
    description = "k3s Kubernetes API server"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = var.allowed_k8s_api_cidrs
  }

  # Egress: all outbound traffic
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "synapsestate-${var.environment}-k3s-sg"
  }
}

# -----------------------------------------------------------------------------
# Compute & k3s Host VM Provisioning (ARCH §12.1)
# -----------------------------------------------------------------------------

data "aws_ami" "ubuntu" {
  most_recent = true

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  owners = ["099720109477"] # Canonical
}

resource "aws_key_pair" "synapse_admin" {
  count      = var.ssh_public_key != "" ? 1 : 0
  key_name   = "synapsestate-${var.environment}-admin-key"
  public_key = var.ssh_public_key
}

resource "aws_eip" "k3s_eip" {
  domain = "vpc"

  tags = {
    Name = "synapsestate-${var.environment}-k3s-eip"
  }
}

resource "aws_instance" "k3s_node" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  subnet_id     = aws_subnet.synapse_public_subnet.id

  vpc_security_group_ids = [aws_security_group.synapse_k3s_sg.id]
  key_name               = var.ssh_public_key != "" ? aws_key_pair.synapse_admin[0].key_name : null

  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = var.root_volume_type
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "synapsestate-${var.environment}-root-volume"
    }
  }

  user_data = <<-EOF
              #!/bin/bash
              set -euxo pipefail

              # Update packages and install prerequisites
              apt-get update -y
              apt-get install -y curl ca-certificates open-iscsi nfs-common

              # Install lightweight k3s Kubernetes distribution
              curl -sfL https://get.k3s.io | sh -s - \
                --write-kubeconfig-mode 644 \
                --tls-san "${aws_eip.k3s_eip.public_ip}"

              # Wait for k3s cluster readiness
              until /usr/local/bin/kubectl get nodes | grep -q "Ready"; do
                echo "Waiting for k3s node readiness..."
                sleep 5
              done

              # Initialize isolated target namespaces (ARCH §12.1)
              /usr/local/bin/kubectl create namespace synapse-system --dry-run=client -o yaml | /usr/local/bin/kubectl apply -f -
              /usr/local/bin/kubectl create namespace observability --dry-run=client -o yaml | /usr/local/bin/kubectl apply -f -
              /usr/local/bin/kubectl create namespace workloads --dry-run=client -o yaml | /usr/local/bin/kubectl apply -f -

              echo "k3s initialization and SynapseState namespaces established successfully."
              EOF

  tags = {
    Name = "synapsestate-${var.environment}-k3s-node"
    Role = "k3s-control-plane-and-worker"
  }
}

resource "aws_eip_association" "k3s_eip_assoc" {
  instance_id   = aws_instance.k3s_node.id
  allocation_id = aws_eip.k3s_eip.id
}

# -----------------------------------------------------------------------------
# Tamper-Evident Audit Ledger Checkpoint Storage (ARCH §8.3 & Invariant 7)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "checkpoint_bucket" {
  bucket              = "${var.s3_backup_bucket_name}-${var.environment}"
  object_lock_enabled = var.enable_object_lock

  tags = {
    Name        = "${var.s3_backup_bucket_name}-${var.environment}"
    Description = "Immutable write-once external audit ledger checkpoint store"
  }
}

resource "aws_s3_bucket_versioning" "checkpoint_versioning" {
  bucket = aws_s3_bucket.checkpoint_bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "checkpoint_encryption" {
  bucket = aws_s3_bucket.checkpoint_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "checkpoint_pab" {
  bucket = aws_s3_bucket.checkpoint_bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_object_lock_configuration" "checkpoint_lock" {
  count  = var.enable_object_lock ? 1 : 0
  bucket = aws_s3_bucket.checkpoint_bucket.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.object_lock_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.checkpoint_versioning]
}

# -----------------------------------------------------------------------------
# Isolated Checkpoint Signer IAM Role & Policy (ARCH §8.3)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "checkpoint_signer_role" {
  name = "synapsestate-${var.environment}-checkpoint-signer-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name        = "synapsestate-${var.environment}-checkpoint-signer-role"
    Description = "Isolated IAM role for automated audit checkpoint signer CronJob"
  }
}

resource "aws_iam_policy" "checkpoint_signer_policy" {
  name        = "synapsestate-${var.environment}-checkpoint-signer-policy"
  description = "Write-only permission to store checkpoints; prohibits deletion"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowCheckpointUpload"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.checkpoint_bucket.arn}/checkpoints/*"
      },
      {
        Sid    = "DenyCheckpointTampering"
        Effect = "Deny"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion"
        ]
        Resource = "${aws_s3_bucket.checkpoint_bucket.arn}/*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "checkpoint_signer_attach" {
  role       = aws_iam_role.checkpoint_signer_role.name
  policy_arn = aws_iam_policy.checkpoint_signer_policy.arn
}

# -----------------------------------------------------------------------------
# Route53 DNS Records (ARCH §12.2)
# -----------------------------------------------------------------------------

resource "aws_route53_record" "api" {
  count   = var.dns_zone_id != "" ? 1 : 0
  zone_id = var.dns_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.k3s_eip.public_ip]
}

resource "aws_route53_record" "shop" {
  count   = var.dns_zone_id != "" ? 1 : 0
  zone_id = var.dns_zone_id
  name    = "shop.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.k3s_eip.public_ip]
}
