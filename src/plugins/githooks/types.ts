export type HookTool = "lefthook" | "husky" | "raw";

export interface GitHookCommand {
  name: string;
  run: string;
}

export interface GitHook {
  lifecycle: string;
  tool: HookTool;
  commands: GitHookCommand[];
  source: string;
}
