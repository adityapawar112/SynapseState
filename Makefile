.PHONY: all help tf-init tf-fmt tf-validate tf-plan tf-apply teardown helm-lint helm-template lint build test check-all

SHELL := /bin/bash

help: ## Display available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

tf-init: ## Initialize Terraform providers and backend
	cd deploy/terraform && terraform init

tf-fmt: ## Check and apply Terraform canonical formatting
	cd deploy/terraform && terraform fmt

tf-validate: ## Validate Terraform syntax and configuration
	cd deploy/terraform && terraform validate

tf-plan: ## Generate Terraform speculative execution plan
	cd deploy/terraform && terraform plan

tf-apply: ## Apply Terraform infrastructure changes to cloud
	cd deploy/terraform && terraform apply -auto-approve

teardown: ## Destroy provisioned cloud infrastructure for cost management (ROADMAP §2.3)
	cd deploy/terraform && terraform destroy -auto-approve

helm-lint: ## Lint all SynapseState Helm charts
	helm lint deploy/helm/control-api
	helm lint deploy/helm/demo-shop

helm-template: ## Dry-run render Helm templates locally
	helm template synapse-control-api deploy/helm/control-api
	helm template synapse-demo-shop deploy/helm/demo-shop

lint: ## Run ESLint across monorepo packages
	pnpm run lint

build: ## Build all workspace packages and apps
	pnpm -r run build

test: ## Run test suite across workspace packages
	pnpm run test

check-all: lint build helm-lint ## Execute comprehensive local quality gates
	cd deploy/terraform && terraform fmt -check && terraform validate
