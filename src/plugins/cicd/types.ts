export type CICDSystem = "github-actions" | "circleci";

export interface CICDTrigger {
  event: string;
  branches?: string[];
  paths?: string[];
  inputs?: string[];
  schedule?: string;
}

export interface CICDJob {
  name: string;
  runner?: string;
  needs?: string[];
  stepCount: number;
  actions?: string[];
  services?: string[];
  matrix?: string[];
  deployTarget?: string;
  environment?: string;
}

export interface CICDPipeline {
  file: string;
  system: CICDSystem;
  name: string;
  triggers: CICDTrigger[];
  jobs: CICDJob[];
  reusableWorkflows?: string[];
  isReusable?: boolean;
  environments?: string[];
  secrets?: string[];
  envVars?: string[];
  concurrencyGroup?: string;
}
