output "vpc_id" {
  description = "The ID of the SynapseState VPC"
  value       = aws_vpc.synapse_vpc.id
}

output "subnet_id" {
  description = "The ID of the public subnet where k3s runs"
  value       = aws_subnet.synapse_public_subnet.id
}

output "security_group_id" {
  description = "The ID of the k3s host security group"
  value       = aws_security_group.synapse_k3s_sg.id
}

output "instance_id" {
  description = "The EC2 Instance ID of the k3s node"
  value       = aws_instance.k3s_node.id
}

output "public_ip" {
  description = "The public Elastic IP assigned to the k3s node"
  value       = aws_eip.k3s_eip.public_ip
}

output "checkpoint_bucket_name" {
  description = "The name of the immutable S3 audit checkpoint bucket"
  value       = aws_s3_bucket.checkpoint_bucket.id
}

output "checkpoint_bucket_arn" {
  description = "The ARN of the immutable S3 audit checkpoint bucket"
  value       = aws_s3_bucket.checkpoint_bucket.arn
}

output "checkpoint_signer_role_arn" {
  description = "The ARN of the isolated write-only IAM role for the checkpoint signer CronJob"
  value       = aws_iam_role.checkpoint_signer_role.arn
}

output "api_endpoint" {
  description = "Public URL for SynapseState Control API"
  value       = var.dns_zone_id != "" ? "https://api.${var.domain_name}" : "http://${aws_eip.k3s_eip.public_ip}:3000"
}

output "demo_shop_endpoint" {
  description = "Public URL for SynapseState Demo Shop"
  value       = var.dns_zone_id != "" ? "https://shop.${var.domain_name}" : "http://${aws_eip.k3s_eip.public_ip}:3001"
}

output "kubeconfig_command" {
  description = "Command to fetch the kubeconfig from the provisioned k3s node"
  value       = "ssh -i <your-key.pem> ubuntu@${aws_eip.k3s_eip.public_ip} 'sudo cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/${aws_eip.k3s_eip.public_ip}/g' > kubeconfig.yaml"
}
