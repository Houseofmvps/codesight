module "my_app" {
  source = "./modules/compute/ecs-service"
  count  = var.enable_my_app ? 1 : 0

  image  = "my-app:latest"
  cpu    = 256
  memory = 512

  environment_variables = [
    { name = "DB_HOST", value = "localhost" },
  ]
}

variable "enable_my_app" {
  type    = bool
  default = true
}
