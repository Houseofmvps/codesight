module "billing_api" {
  source = "./modules/compute/ecs-service"
  count  = var.enable_billing_api ? 1 : 0

  image          = "${local.ecr_url_prefix}/billing-service:${var.billing_api_image_tag}"
  cpu            = 512
  memory         = 1024
  desired_count  = 1

  alb_listener_arn = module.alb.https_listener_arn

  host_headers = ["billing.${var.environment}.emergedata.ai"]

  environment_variables = [
    { name = "STRIPE_MODE", value = "live" },
  ]

  secrets = [
    { name = "STRIPE_KEY", valueFrom = "arn:aws:ssm:us-east-1:123456789:parameter/billing/stripe-key" },
  ]
}

variable "enable_billing_api" {
  type    = bool
  default = true
}
