#!/bin/bash

# SnapPlant Infrastructure Destroy Script
# This script safely destroys SnapPlant infrastructure using Terraform

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

# Show current resources
show_current_resources() {
    log_info "Current infrastructure resources:"
    if terraform show &> /dev/null; then
        terraform show | grep -E "(resource|data)" | head -20
    else
        log_warning "No Terraform state found or unable to read state"
    fi
}

# Plan destruction
plan_destruction() {
    log_info "Planning infrastructure destruction..."
    terraform plan -destroy -out=destroy.tfplan
    
    echo ""
    log_warning "The above resources will be PERMANENTLY DESTROYED!"
    log_warning "This action cannot be undone!"
    echo ""
    
    read -p "Are you ABSOLUTELY sure you want to destroy all infrastructure? Type 'destroy' to confirm: " -r
    echo ""
    
    if [[ $REPLY != "destroy" ]]; then
        log_info "Destruction cancelled by user"
        rm -f destroy.tfplan
        exit 0
    fi
    
    # Double confirmation for safety
    read -p "Last chance! Type 'YES' to proceed with destruction: " -r
    echo ""
    
    if [[ $REPLY != "YES" ]]; then
        log_info "Destruction cancelled by user"
        rm -f destroy.tfplan
        exit 0
    fi
}

# Execute destruction
execute_destruction() {
    log_info "Executing infrastructure destruction..."
    terraform apply destroy.tfplan
    rm -f destroy.tfplan
    log_success "Infrastructure destroyed successfully!"
}

# Cleanup state files (optional)
cleanup_state() {
    echo ""
    read -p "Do you want to remove local Terraform state files? (y/N): " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Removing local state files..."
        rm -f terraform.tfstate*
        rm -rf .terraform/
        log_success "Local state files removed"
    else
        log_info "Local state files preserved"
    fi
}

# Main destruction process
main() {
    log_warning "Starting SnapPlant infrastructure destruction..."
    
    # Change to infrastructure directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR/.."
    
    # Check if terraform state exists
    if [ ! -f "terraform.tfstate" ] && [ ! -d ".terraform" ]; then
        log_error "No Terraform state found. Nothing to destroy."
        exit 1
    fi
    
    # Run destruction steps
    check_prerequisites
    show_current_resources
    plan_destruction
    execute_destruction
    cleanup_state
    
    log_success "SnapPlant infrastructure destruction completed!"
    log_info "All Azure resources have been removed."
}

# Show help
show_help() {
    echo "SnapPlant Infrastructure Destroy Script"
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  -h, --help      Show this help message"
    echo "  -p, --plan      Only show destruction plan (no apply)"
    echo "  -f, --force     Skip confirmations (USE WITH EXTREME CAUTION)"
    echo ""
    echo "Examples:"
    echo "  $0              Destroy infrastructure (with confirmations)"
    echo "  $0 --plan       Only show destruction plan"
    echo "  $0 --force      Destroy without confirmations (DANGEROUS)"
}

# Force destruction (skip confirmations)
force_destruction() {
    log_warning "FORCE MODE: Destroying infrastructure without confirmations!"
    
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR/.."
    
    check_prerequisites
    
    log_info "Executing force destruction..."
    terraform destroy -auto-approve
    
    log_success "Force destruction completed!"
}

# Handle command line arguments
case "${1:-}" in
    -h|--help)
        show_help
        exit 0
        ;;
    -p|--plan)
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        cd "$SCRIPT_DIR/.."
        check_prerequisites
        terraform plan -destroy
        exit 0
        ;;
    -f|--force)
        log_error "Force mode is disabled for safety. Please run without --force flag."
        exit 1
        # Uncomment the line below to enable force mode (NOT RECOMMENDED)
        # force_destruction
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