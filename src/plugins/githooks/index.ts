import type { CodesightPlugin, ProjectInfo } from "../../types.js";
import { parseLefthook } from "./lefthook.js";
import { parseHusky } from "./husky.js";
import { parseRawHooks } from "./raw.js";
import { formatGitHooks } from "./formatter.js";

export type { GitHook, GitHookCommand, HookTool } from "./types.js";

export function createGitHooksPlugin(): CodesightPlugin {
  return {
    name: "githooks",
    detector: async (_files: string[], project: ProjectInfo) => {
      const [lefthookHooks, huskyHooks, rawHooks] = await Promise.all([
        parseLefthook(project.root),
        parseHusky(project.root),
        parseRawHooks(project.root),
      ]);

      // If a managed tool (lefthook/husky) handles a lifecycle, suppress the
      // raw hook for it — managed tools install raw hooks that just delegate.
      const managedLifecycles = new Set([
        ...lefthookHooks.map(h => h.lifecycle),
        ...huskyHooks.map(h => h.lifecycle),
      ]);
      const filteredRaw = rawHooks.filter(h => !managedLifecycles.has(h.lifecycle));

      const allHooks = [...lefthookHooks, ...huskyHooks, ...filteredRaw];
      if (allHooks.length === 0) return {};

      return {
        customSections: [{ name: "githooks", content: formatGitHooks(allHooks) }],
      };
    },
  };
}
