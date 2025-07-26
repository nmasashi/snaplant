#!/bin/bash

# SnapPlant Infrastructure Deployment Script
# This script automates the deployment of SnapPlant infrastructure using Terraform

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if Terraform is installed
    if ! command -v terraform &> /dev/null; then
        log_error "Terraform is not installed. Please install Terraform first."
        exit 1
    fi
    
    # Check if Azure CLI is installed
    if ! command -v az &> /dev/null; then
        log_error "Azure CLI is not installed. Please install Azure CLI first."
        exit 1
    fi
    
    # Check if logged in to Azure
    if ! az account show &> /dev/null; then
        log_error "Not logged in to Azure. Please run 'az login' first."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Initialize Terraform
init_terraform() {
    log_info "Initializing Terraform..."
    terraform init
    log_success "Terraform initialized"
}

# Validate Terraform configuration
validate_terraform() {
    log_info "Validating Terraform configuration..."
    terraform validate
    log_success "Terraform configuration is valid"
}

# Plan Terraform deployment
plan_terraform() {
    log_info "Planning Terraform deployment..."
    terraform plan -out=tfplan
    
    echo ""
    log_warning "Please review the plan above carefully."
    read -p "Do you want to continue with the deployment? (y/N): " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Deployment cancelled by user"
        rm -f tfplan
        exit 0
    fi
}

# Apply Terraform deployment
apply_terraform() {
    log_info "Applying Terraform deployment..."
    terraform apply tfplan
    rm -f tfplan
    log_success "Deployment completed successfully!"
}

# Show outputs
show_outputs() {
    log_info "Deployment outputs:"
    terraform output deployment_summary
}

# Main deployment process
main() {
    log_info "Starting SnapPlant infrastructure deployment..."
    
    # Change to infrastructure directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR/.."
    
    # Check if terraform.tfvars exists
    if [ ! -f "terraform.tfvars" ]; then
        log_warning "terraform.tfvars not found. Creating from example..."
        if [ -f "terraform.tfvars.example" ]; then
            cp terraform.tfvars.example terraform.tfvars
            log_warning "Please edit terraform.tfvars with your specific values before running this script again."
            exit 1
        else
            log_error "terraform.tfvars.example not found. Cannot proceed."
            exit 1
        fi
    fi
    
    # Run deployment steps
    check_prerequisites
    init_terraform
    validate_terraform
    plan_terraform
    apply_terraform
    show_outputs
    
    log_success "SnapPlant infrastructure deployment completed!"
    log_info "You can now deploy your application code to the created Function App."
}

# Show help
show_help() {
    echo "SnapPlant Infrastructure Deployment Script"
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -p, --plan     Only run terraform plan (no apply)"
    echo "  -d, --destroy  Destroy the infrastructure"
    echo ""
    echo "Examples:"
    echo "  $0             Deploy infrastructure"
    echo "  $0 --plan      Only show deployment plan"
    echo "  $0 --destroy   Destroy infrastructure"
}

# Handle command line arguments
case "${1:-}" in
    -h|--help)
        show_help
        exit 0
        ;;
    -p|--plan)
        check_prerequisites
        init_terraform
        validate_terraform
        terraform plan
        exit 0
        ;;
    -d|--destroy)
        log_warning "This will destroy all SnapPlant infrastructure!"
        read -p "Are you sure you want to continue? (y/N): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            terraform destroy
            log_success "Infrastructure destroyed"
        else
            log_info "Destruction cancelled"
        fi
        exit 0
        ;;
    "")
        main
        ;;
    *)
        log_error "Unknown option: $1"
        show_help
        exit 1
        ;;
esac