# Project configuration
variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "snaplant"
}

variable "location" {
  description = "Azure region for resources"
  type        = string
  default     = "Japan East"
}

variable "tags" {
  description = "A map of tags to add to all resources"
  type        = map(string)
  default = {
    Project   = "SnapPlant"
    ManagedBy = "Terraform"
  }
}

# Cosmos DB configuration
variable "cosmos_db_consistency_level" {
  description = "Consistency level for Cosmos DB"
  type        = string
  default     = "Session"
  validation {
    condition = contains([
      "BoundedStaleness",
      "Eventual",
      "Session",
      "Strong",
      "ConsistentPrefix"
    ], var.cosmos_db_consistency_level)
    error_message = "Cosmos DB consistency level must be one of: BoundedStaleness, Eventual, Session, Strong, ConsistentPrefix."
  }
}

variable "cosmos_db_throughput" {
  description = "Throughput for Cosmos DB container (RU/s)"
  type        = number
  default     = 400
  validation {
    condition     = var.cosmos_db_throughput >= 400 && var.cosmos_db_throughput <= 1000000
    error_message = "Cosmos DB throughput must be between 400 and 1000000 RU/s."
  }
}

# Azure Functions configuration
variable "functions_plan_tier" {
  description = "SKU for the App Service Plan"
  type        = string
  default     = "Y1"  # Consumption plan
  validation {
    condition = contains([
      "Y1",  # Consumption
      "EP1", # Premium v2
      "EP2", # Premium v2
      "EP3"  # Premium v2
    ], var.functions_plan_tier)
    error_message = "Functions plan tier must be one of: Y1 (Consumption), EP1, EP2, EP3 (Premium)."
  }
}


# Storage configuration
variable "storage_account_tier" {
  description = "Storage account tier"
  type        = string
  default     = "Standard"
  validation {
    condition = contains([
      "Standard",
      "Premium"
    ], var.storage_account_tier)
    error_message = "Storage account tier must be either Standard or Premium."
  }
}

variable "storage_replication_type" {
  description = "Storage account replication type"
  type        = string
  default     = "LRS"
  validation {
    condition = contains([
      "LRS",  # Locally redundant storage
      "GRS",  # Geo-redundant storage
      "RAGRS", # Read-access geo-redundant storage
      "ZRS",  # Zone-redundant storage
      "GZRS", # Geo-zone-redundant storage
      "RAGZRS" # Read-access geo-zone-redundant storage
    ], var.storage_replication_type)
    error_message = "Storage replication type must be one of: LRS, GRS, RAGRS, ZRS, GZRS, RAGZRS."
  }
}

# Application Insights configuration
variable "application_insights_type" {
  description = "Application type for Application Insights"
  type        = string
  default     = "web"
  validation {
    condition = contains([
      "web",
      "other"
    ], var.application_insights_type)
    error_message = "Application Insights type must be either 'web' or 'other'."
  }
}

# Azure OpenAI configuration
variable "openai_location" {
  description = "Azure region for OpenAI service (limited availability)"
  type        = string
  default     = "East US"
  validation {
    condition = contains([
      "East US",
      "East US 2", 
      "North Central US",
      "South Central US",
      "West Europe",
      "France Central",
      "UK South"
    ], var.openai_location)
    error_message = "OpenAI location must be in a supported region."
  }
}

variable "openai_sku" {
  description = "SKU for Azure OpenAI service"
  type        = string
  default     = "S0"
  validation {
    condition = contains([
      "F0",  # Free tier (limited)
      "S0"   # Standard tier
    ], var.openai_sku)
    error_message = "OpenAI SKU must be either F0 or S0."
  }
}