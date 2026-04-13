module "notifications_worker" {
  source = "./modules/compute/ecs-worker"
  count  = var.enable_notifications ? 1 : 0

  image  = "${local.ecr_url_prefix}/notifications:latest"
  cpu    = 128
  memory = 256

  environment_variables = [
    { name = "QUEUE_URL", value = module.sqs_notifications.url },
  ]
}

variable "enable_notifications" {
  type    = bool
  default = true
}
