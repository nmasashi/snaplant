#!/bin/bash

# Get Azure Function App Publish Profile for GitHub Actions
# This script retrieves the publish profile needed for GitHub Actions deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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
    
    if ! command -v az &> /dev/null; then
        log_error "Azure CLI is not installed. Please install Azure CLI first."
        exit 1
    fi
    
    if ! az account show &> /dev/null; then
        log_error "Not logged in to Azure. Please run 'az login' first."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Get infrastructure outputs
get_infrastructure_outputs() {
    log_info "Getting infrastructure outputs..."
    
    # Change to infrastructure directory
    cd "$(dirname "${BASH_SOURCE[0]}")/.."
    
    # Get outputs from Terraform
    FUNCTION_APP_NAME=$(terraform output -raw function_app_name)
    RESOURCE_GROUP_NAME=$(terraform output -raw resource_group_name)
    
    if [ -z "$FUNCTION_APP_NAME" ] || [ -z "$RESOURCE_GROUP_NAME" ]; then
        log_error "Failed to get infrastructure outputs. Make sure Terraform has been applied."
        exit 1
    fi
    
    log_info "Function App: $FUNCTION_APP_NAME"
    log_info "Resource Group: $RESOURCE_GROUP_NAME"
}

# Get publish profile
get_publish_profile() {
    log_info "Getting publish profile..."
    
    # Get the publish profile
    PUBLISH_PROFILE=$(az functionapp deployment list-publishing-profiles \
        --name "$FUNCTION_APP_NAME" \
        --resource-group "$RESOURCE_GROUP_NAME" \
        --xml)
    
    if [ -z "$PUBLISH_PROFILE" ]; then
        log_error "Failed to get publish profile"
        exit 1
    fi
    
    log_success "Publish profile retrieved successfully"
}

# Display instructions
show_instructions() {
    echo ""
    log_info "GitHub Actions Setup Instructions:"
    echo ""
    echo "1. Go to your GitHub repository"
    echo "2. Navigate to Settings > Secrets and variables > Actions"
    echo "3. Add the following secrets:"
    echo ""
    echo "   Secret Name: AZURE_FUNCTIONAPP_NAME"
    echo "   Secret Value: $FUNCTION_APP_NAME"
    echo ""
    echo "   Secret Name: AZURE_FUNCTIONAPP_PUBLISH_PROFILE"
    echo "   Secret Value: (copy the XML content below)"
    echo ""
    log_warning "IMPORTANT: Copy the entire XML content including the opening and closing tags"
    echo ""
    echo "======================== PUBLISH PROFILE (copy this) ========================"
    echo "$PUBLISH_PROFILE"
    echo "======================== END PUBLISH PROFILE ========================"
    echo ""
    log_info "After setting up these secrets, GitHub Actions will automatically deploy your Function App when you push to the main branch."
}

# Main function
main() {
    log_info "Starting publish profile retrieval..."
    
    check_prerequisites
    get_infrastructure_outputs
    get_publish_profile
    show_instructions
    
    log_success "Setup complete! Follow the instructions above to configure GitHub Actions."
}

# Show help
show_help() {
    echo "Get Azure Function App Publish Profile for GitHub Actions"
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo ""
    echo "This script retrieves the publish profile needed for GitHub Actions deployment"
    echo "and provides instructions for setting up the GitHub secrets."
}

# Handle command line arguments
case "${1:-}" in
    -h|--help)
        show_help
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