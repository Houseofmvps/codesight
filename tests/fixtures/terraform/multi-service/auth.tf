module "auth_service" {
  source = "./modules/compute/ecs-service"
  count  = var.enable_auth_service ? 1 : 0

  image  = "${local.ecr_url_prefix}/auth-service:latest"
  cpu    = 256
  memory = 512

  alb_listener_arn = module.alb.https_listener_arn

  host_headers = ["auth.${var.environment}.emergedata.ai"]

  environment_variables = [
    { name = "OAUTH_PROVIDER", value = "google" },
  ]
}

variable "enable_auth_service" {
  type    = bool
  default = true
}
