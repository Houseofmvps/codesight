import { basename } from "node:path";
import type { CICDPipeline, CICDTrigger, CICDJob } from "./types.js";

/**
 * Extract GitHub Actions workflow pipelines from a parsed YAML object.
 */
export function extractGitHubActionsWorkflow(
  parsed: any,
  relPath: string,
  rawContent: string,
): CICDPipeline | null {
  if (!parsed || typeof parsed !== "object") return null;

  const name = parsed.name || basename(relPath, ".yml").replace(/-/g, " ");
  const triggers = extractTriggers(parsed.on || parsed.true); // YAML parses bare `on:` as `true:` sometimes
  const jobs = extractJobs(parsed.jobs);
  const reusableWorkflows = collectReusableWorkflowRefs(parsed.jobs);
  const isReusable = triggers.some(t => t.event === "workflow_call");
  const secrets = extractSecrets(rawContent);
  const envVars = parsed.env ? Object.keys(parsed.env) : undefined;

  const environments = [
    ...new Set(jobs.map(j => j.environment).filter(Boolean) as string[]),
  ];

  const concurrencyGroup = typeof parsed.concurrency === "string"
    ? parsed.concurrency
    : parsed.concurrency?.group || undefined;

  const pipeline: CICDPipeline = {
    file: relPath,
    system: "github-actions",
    name: String(name),
    triggers,
    jobs,
  };

  if (reusableWorkflows.length > 0) pipeline.reusableWorkflows = reusableWorkflows;
  if (isReusable) pipeline.isReusable = true;
  if (environments.length > 0) pipeline.environments = environments;
  if (secrets && secrets.length > 0) pipeline.secrets = secrets;
  if (envVars && envVars.length > 0) pipeline.envVars = envVars;
  if (concurrencyGroup) pipeline.concurrencyGroup = String(concurrencyGroup);

  return pipeline;
}

function extractTriggers(on: any): CICDTrigger[] {
  if (!on) return [];
  if (typeof on === "string") return [{ event: on }];
  if (Array.isArray(on)) return on.map(e => ({ event: String(e) }));
  if (typeof on === "object") {
    return Object.entries(on).map(([event, config]: [string, any]) => {
      const trigger: CICDTrigger = { event };
      if (config && typeof config === "object") {
        if (config.branches) trigger.branches = asArray(config.branches);
        if (config.paths) trigger.paths = asArray(config.paths);
        if (config.inputs) trigger.inputs = Object.keys(config.inputs);
        if (typeof config === "string") trigger.schedule = config;
        // schedule is an array of cron objects
        if (Array.isArray(config) && config[0]?.cron) {
          trigger.schedule = config[0].cron;
        }
      }
      return trigger;
    });
  }
  return [];
}

function extractJobs(jobs: any): CICDJob[] {
  if (!jobs || typeof jobs !== "object") return [];

  return Object.entries(jobs).map(([name, job]: [string, any]) => {
    if (!job || typeof job !== "object") {
      return { name, stepCount: 0 };
    }

    const steps: any[] = Array.isArray(job.steps) ? job.steps : [];
    const actions = steps
      .filter((s: any) => s && s.uses)
      .map((s: any) => String(s.uses));

    const result: CICDJob = {
      name,
      stepCount: steps.length,
    };

    // Runner
    if (job["runs-on"]) {
      result.runner = stringifyRunner(job["runs-on"]);
    }

    // Job is a reusable workflow call (uses: at job level, not step level)
    if (job.uses && typeof job.uses === "string") {
      result.actions = [job.uses];
      result.stepCount = 1;
    } else if (actions.length > 0) {
      result.actions = actions;
    }

    // Dependencies
    if (job.needs) result.needs = asArray(job.needs);

    // Environment
    if (job.environment) {
      result.environment = typeof job.environment === "string"
        ? job.environment
        : job.environment?.name;
    }

    // Services
    if (job.services && typeof job.services === "object") {
      result.services = Object.keys(job.services);
    }

    // Matrix
    if (job.strategy?.matrix && typeof job.strategy.matrix === "object") {
      result.matrix = Object.keys(job.strategy.matrix)
        .filter(k => k !== "include" && k !== "exclude");
    }

    // Deploy target
    result.deployTarget = inferDeployTarget(
      result.actions || [],
      steps,
    );

    return result;
  });
}

function collectReusableWorkflowRefs(jobs: any): string[] {
  if (!jobs || typeof jobs !== "object") return [];
  const refs: string[] = [];
  for (const job of Object.values(jobs) as any[]) {
    if (job?.uses && typeof job.uses === "string" && job.uses.startsWith("./")) {
      refs.push(job.uses);
    }
    if (Array.isArray(job?.steps)) {
      for (const step of job.steps) {
        if (step?.uses && typeof step.uses === "string" && step.uses.startsWith("./")) {
          refs.push(step.uses);
        }
      }
    }
  }
  return [...new Set(refs)];
}

function extractSecrets(rawContent: string): string[] {
  const pattern = /\$\{\{\s*secrets\.(\w+)\s*\}\}/g;
  const secrets = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(rawContent)) !== null) {
    secrets.add(m[1]);
  }
  return [...secrets].sort();
}

function inferDeployTarget(actions: string[], steps: any[]): string | undefined {
  const allText = [
    ...actions,
    ...steps.map((s: any) => String(s?.run || "")),
  ].join(" ").toLowerCase();

  if (allText.includes("ecs") || allText.includes("amazon-ecs")) return "ecs";
  if (allText.includes("lambda") && allText.includes("deploy")) return "lambda";
  if (allText.includes("s3") && (allText.includes("deploy") || allText.includes("sync"))) return "s3";
  if (allText.includes("vercel")) return "vercel";
  if (allText.includes("fly deploy") || allText.includes("flyctl")) return "fly";
  if (allText.includes("netlify")) return "netlify";
  if (allText.includes("heroku")) return "heroku";
  if (allText.includes("wrangler") || allText.includes("cloudflare")) return "cloudflare";
  if (allText.includes("gcloud") || allText.includes("cloud run")) return "gcp";
  if (allText.includes("azure") && allText.includes("deploy")) return "azure";
  if (allText.includes("docker push") || allText.includes("ecr-login") || allText.includes("amazon-ecr")) return "container-registry";
  return undefined;
}

function asArray(val: any): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}

function stringifyRunner(val: any): string {
  if (Array.isArray(val)) return `[${val.join(", ")}]`;
  return String(val);
}
