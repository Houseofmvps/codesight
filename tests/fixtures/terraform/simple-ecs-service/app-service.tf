variable "enable_app_service" {
  description = "Enable the app service"
  type        = bool
  default     = true
}

variable "app_service_image_tag" {
  description = "Docker image tag for app service"
  type        = string
  default     = "latest"
}

module "app_service" {
  source = "./modules/compute/ecs-service"
  count  = var.enable_app_service ? 1 : 0

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
  cluster_arn = module.ecs_cluster.cluster_arn
  alb_listener_arn = module.alb.https_listener_arn

  image          = "${local.ecr_url_prefix}/app-service:${var.app_service_image_tag}"
  container_port = 8080
  cpu            = 512
  memory         = 1024
  desired_count  = var.app_service_desired_count

  health_check_path = "/health"

  host_headers = [
    var.environment == "production" ? "app.emergedata.ai" : "app.${var.environment}.emergedata.ai"
  ]

  enable_service_connect = true
  service_connect_namespace = module.ecs_cluster.service_discovery_namespace_arn

  environment_variables = [
    { name = "ENVIRONMENT", value = var.environment },
    { name = "SERVICE_NAME", value = "app-service" },
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "8080" },
    { name = "LOG_LEVEL", value = "INFO" },
    { name = "S3_BUCKET", value = "emerge-protocol-${var.environment}-landing" },
    { name = "REDIS_URL", value = "redis://redis:6379" },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = "arn:aws:ssm:us-east-1:123456789:parameter/rds/dsn" },
    { name = "JWT_SECRET", valueFrom = "arn:aws:ssm:us-east-1:123456789:parameter/app-service/jwt-secret-key" },
    { name = "API_KEY", valueFrom = "arn:aws:ssm:us-east-1:123456789:parameter/app-service/api-key" },
  ]

  task_policy_arns = [local.ecs_secrets_policy_arn]
}

module "app_service_worker" {
  source = "./modules/compute/ecs-worker"
  count  = var.enable_app_service ? 1 : 0

  image         = "${local.ecr_url_prefix}/app-service:${var.app_service_image_tag}"
  cpu           = 256
  memory        = 512
  desired_count = 1

  environment_variables = [
    { name = "ENVIRONMENT", value = var.environment },
    { name = "WORKER_MODE", value = "true" },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = "arn:aws:ssm:us-east-1:123456789:parameter/rds/dsn" },
  ]
}

resource "aws_route53_record" "app_service" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "app.${var.environment}.emergedata.ai"
  type    = "A"

  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = true
  }
}
