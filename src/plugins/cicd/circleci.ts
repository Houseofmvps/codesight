import type { CICDPipeline, CICDTrigger, CICDJob } from "./types.js";

/**
 * Extract CircleCI pipelines from a parsed config.yml.
 *
 * CircleCI has a two-level structure:
 * - `jobs:` defines job bodies (executor, steps)
 * - `workflows:` composes jobs with dependencies, contexts, and filters
 *
 * Each workflow becomes a CICDPipeline.
 */
export function extractCircleCIWorkflows(
  parsed: any,
  relPath: string,
  rawContent: string,
): CICDPipeline[] {
  if (!parsed || typeof parsed !== "object") return [];

  const jobDefs = parsed.jobs || {};
  const workflows = parsed.workflows || {};
  const orbs = parsed.orbs ? Object.keys(parsed.orbs) : [];
  const parameters = parsed.parameters || {};

  const pipelines: CICDPipeline[] = [];

  for (const [name, wf] of Object.entries(workflows)) {
    if (name === "version") continue; // CircleCI sometimes puts version in workflows
    if (!wf || typeof wf !== "object") continue;

    const wfObj = wf as Record<string, any>;
    const jobRefs: any[] = Array.isArray(wfObj.jobs) ? wfObj.jobs : [];

    const jobs = extractJobs(jobRefs, jobDefs);
    const triggers = extractTriggers(jobRefs, parameters, wfObj);
    const environments = collectEnvironments(jobRefs);
    const secrets = extractSecrets(rawContent);

    const pipeline: CICDPipeline = {
      file: relPath,
      system: "circleci",
      name,
      triggers,
      jobs,
    };

    if (environments.length > 0) pipeline.environments = environments;
    if (secrets.length > 0) pipeline.secrets = secrets;
    if (orbs.length > 0) pipeline.envVars = orbs.map(o => `orb:${o}`);

    pipelines.push(pipeline);
  }

  return pipelines;
}

function extractJobs(
  jobRefs: any[],
  jobDefs: Record<string, any>,
): CICDJob[] {
  return jobRefs.map(ref => {
    const [jobName, jobConfig] = parseJobRef(ref);
    const jobDef = jobDefs[jobName] || {};

    const steps: any[] = Array.isArray(jobDef.steps) ? jobDef.steps : [];

    const result: CICDJob = {
      name: (jobConfig?.name as string) || jobName,
      stepCount: steps.length,
    };

    // Runner from job definition
    if (Array.isArray(jobDef.docker) && jobDef.docker[0]?.image) {
      result.runner = String(jobDef.docker[0].image);
    } else if (jobDef.machine) {
      result.runner = typeof jobDef.machine === "string"
        ? jobDef.machine
        : jobDef.machine?.image || "machine";
    } else if (jobDef.macos) {
      result.runner = `macos:${jobDef.macos.xcode || "latest"}`;
    } else if (jobDef.resource_class) {
      result.runner = String(jobDef.resource_class);
    }

    // Dependencies from workflow config
    if (jobConfig?.requires) {
      result.needs = asArray(jobConfig.requires);
    }

    // Context as environment
    if (jobConfig?.context) {
      const contexts = asArray(jobConfig.context);
      if (contexts.length > 0) result.environment = contexts.join(", ");
    }

    // Detect approval jobs
    if (jobConfig?.type === "approval") {
      result.stepCount = 0;
      result.runner = "approval-gate";
    }

    // Collect orb commands and special steps as actions
    const actions: string[] = [];
    for (const step of steps) {
      if (typeof step === "string" && step !== "checkout") {
        actions.push(step);
      } else if (step && typeof step === "object") {
        const stepKeys = Object.keys(step);
        for (const k of stepKeys) {
          if (k !== "run" && k !== "checkout" && k !== "when" && k !== "unless") {
            actions.push(k);
          }
        }
      }
    }
    if (actions.length > 0) result.actions = actions;

    return result;
  });
}

function extractTriggers(
  jobRefs: any[],
  parameters: Record<string, any>,
  workflow: Record<string, any>,
): CICDTrigger[] {
  const triggers: CICDTrigger[] = [];
  const seenEvents = new Set<string>();

  // Check for parameter-based triggers (manual/conditional)
  const paramInputs: string[] = [];
  for (const [pName, pDef] of Object.entries(parameters)) {
    if (pDef && typeof pDef === "object" && pDef.type === "boolean") {
      paramInputs.push(pName);
    }
  }
  if (paramInputs.length > 0) {
    triggers.push({ event: "parameter", inputs: paramInputs });
    seenEvents.add("parameter");
  }

  // Extract triggers from job filters
  for (const ref of jobRefs) {
    const [, jobConfig] = parseJobRef(ref);
    if (!jobConfig?.filters) continue;

    const filters = jobConfig.filters;
    if (filters.branches) {
      if (!seenEvents.has("push")) {
        const trigger: CICDTrigger = { event: "push" };
        if (filters.branches.only) trigger.branches = asArray(filters.branches.only);
        triggers.push(trigger);
        seenEvents.add("push");
      }
    }
    if (filters.tags) {
      if (!seenEvents.has("tag")) {
        const trigger: CICDTrigger = { event: "tag" };
        if (filters.tags.only) trigger.tags = asArray(filters.tags.only);
        triggers.push(trigger);
        seenEvents.add("tag");
      }
    }
  }

  // Default: if no explicit triggers found, it's a push trigger
  if (triggers.length === 0) {
    triggers.push({ event: "push" });
  }

  // Check for scheduled triggers
  if (workflow.triggers) {
    const wfTriggers = Array.isArray(workflow.triggers)
      ? workflow.triggers
      : [workflow.triggers];
    for (const t of wfTriggers) {
      if (t?.schedule?.cron) {
        triggers.push({ event: "schedule", schedule: t.schedule.cron });
      }
    }
  }

  return triggers;
}

function collectEnvironments(jobRefs: any[]): string[] {
  const envs = new Set<string>();
  for (const ref of jobRefs) {
    const [, jobConfig] = parseJobRef(ref);
    if (jobConfig?.context) {
      for (const ctx of asArray(jobConfig.context)) {
        envs.add(ctx);
      }
    }
  }
  return [...envs];
}

function extractSecrets(rawContent: string): string[] {
  // CircleCI doesn't have explicit secret references like GHA,
  // but we can look for environment variable patterns
  const secrets = new Set<string>();
  const patterns = [
    /\$(\w+_(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ARN))\b/g,
    /\$\{(\w+_(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ARN))\}/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rawContent)) !== null) {
      secrets.add(m[1]);
    }
  }
  return [...secrets].sort();
}

function parseJobRef(ref: any): [string, Record<string, any> | null] {
  if (typeof ref === "string") return [ref, null];
  if (ref && typeof ref === "object") {
    const keys = Object.keys(ref);
    if (keys.length > 0) return [keys[0], ref[keys[0]] || {}];
  }
  return ["unknown", null];
}

function asArray(val: any): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}
