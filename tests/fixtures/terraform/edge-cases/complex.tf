# This file tests edge cases for the HCL parser

// C-style comment
variable "basic_var" {
  type    = string
  default = "hello"
}

/* Block comment
   spanning multiple lines
   with { braces } inside */
resource "aws_ecs_task_definition" "with_heredoc" {
  family = "test"

  container_definitions = <<EOF
[
  {
    "name": "app",
    "image": "nginx:latest",
    "essential": true,
    "portMappings": [{ "containerPort": 80 }]
  }
]
EOF
}

resource "aws_security_group_rule" "with_jsonencode" {
  type = "ingress"

  tags = jsonencode({
    Name        = "test"
    Environment = "staging"
    Nested      = { key = "value" }
  })
}

resource "aws_ecs_service" "with_dynamic" {
  name = "dynamic-test"

  dynamic "load_balancer" {
    for_each = var.enable_lb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.main.arn
      container_name   = "app"
      container_port   = 8080
    }
  }
}

# String with hash inside: should not be treated as comment
variable "tricky_string" {
  default = "color is #ff0000 and // not a comment"
}

# Escaped quotes inside strings
variable "escaped_quotes" {
  default = "he said \"hello world\" to me"
}

# Indented heredoc with marker
resource "aws_iam_role_policy" "indented_heredoc" {
  policy = <<-POLICY
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": "s3:GetObject",
          "Resource": "*"
        }
      ]
    }
  POLICY
}

module "for_each_example" {
  source   = "./modules/compute/ecs-service"
  for_each = toset(["a", "b", "c"])

  name     = each.key
  cpu      = 256
  memory   = 512
}

# Nested nested blocks
resource "aws_security_group" "nested_blocks" {
  name = "test"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
