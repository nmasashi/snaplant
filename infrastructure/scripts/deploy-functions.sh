#!/bin/bash

# SnapPlant Azure Functions Deployment Script
# This script deploys the Function App code to Azure

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
    
    # Check if Azure Functions Core Tools is installed
    if ! command -v func &> /dev/null; then
        log_error "Azure Functions Core Tools is not installed. Please install it first."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Get infrastructure outputs
get_infrastructure_outputs() {
    log_info "Getting infrastructure outputs..."
    
    # Change to infrastructure directory
    cd "$(dirname "${BASH_SOURCE[0]}")/.."
    
    # Get Function App name from Terraform output
    FUNCTION_APP_NAME=$(terraform output -raw function_app_name)
    RESOURCE_GROUP_NAME=$(terraform output -raw resource_group_name)
    
    if [ -z "$FUNCTION_APP_NAME" ] || [ -z "$RESOURCE_GROUP_NAME" ]; then
        log_error "Failed to get infrastructure outputs. Make sure Terraform has been applied."
        exit 1
    fi
    
    log_info "Function App: $FUNCTION_APP_NAME"
    log_info "Resource Group: $RESOURCE_GROUP_NAME"
}

# Build the application
build_application() {
    log_info "Building application..."
    
    # Change to API directory
    cd "$(dirname "${BASH_SOURCE[0]}")/../../api"
    
    # Install dependencies
    npm ci
    
    # Build the application
    npm run build
    
    log_success "Application built successfully"
}

# Deploy to Azure Functions
deploy_functions() {
    log_info "Deploying to Azure Functions..."
    
    # Deploy using Azure Functions Core Tools
    func azure functionapp publish "$FUNCTION_APP_NAME" --build remote
    
    log_success "Deployment completed successfully!"
}

# Update environment variables
update_environment_variables() {
    log_info "Updating environment variables..."
    
    # You may need to set additional environment variables here
    # Example:
    # az functionapp config appsettings set \
    #     --name "$FUNCTION_APP_NAME" \
    #     --resource-group "$RESOURCE_GROUP_NAME" \
    #     --settings "CUSTOM_SETTING=value"
    
    log_info "Environment variables updated"
}

# Show deployment info
show_deployment_info() {
    log_info "Deployment information:"
    echo ""
    echo "Function App Name: $FUNCTION_APP_NAME"
    echo "Resource Group: $RESOURCE_GROUP_NAME"
    echo "Function App URL: https://$FUNCTION_APP_NAME.azurewebsites.net"
    echo ""
    log_info "You can view logs and monitor the application in the Azure Portal"
}

# Main deployment process
main() {
    log_info "Starting SnapPlant Functions deployment..."
    
    check_prerequisites
    get_infrastructure_outputs
    build_application
    deploy_functions
    update_environment_variables
    show_deployment_info
    
    log_success "SnapPlant Functions deployment completed!"
}

# Show help
show_help() {
    echo "SnapPlant Azure Functions Deployment Script"
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -b, --build    Only build the application (no deploy)"
    echo ""
    echo "Examples:"
    echo "  $0             Deploy application to Azure Functions"
    echo "  $0 --build     Only build the application"
}

# Handle command line arguments
case "${1:-}" in
    -h|--help)
        show_help
        exit 0
        ;;
    -b|--build)
        check_prerequisites
        build_application
        log_success "Build completed!"
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