import { relative, basename } from "node:path";
import { readFileSafe } from "../scanner.js";
import type { MiddlewareInfo, ProjectInfo } from "../types.js";

const MIDDLEWARE_PATTERNS: [MiddlewareInfo["type"], RegExp[]][] = [
  [
    "auth",
    [
      /auth/i,
      /jwt/i,
      /bearer/i,
      /passport/i,
      /clerk/i,
      /better-?auth/i,
      /session/i,
      /requireAuth/i,
      /isAuthenticated/i,
      /verifyToken/i,
      /protect/i,
    ],
  ],
  [
    "rate-limit",
    [
      /rate.?limit/i,
      /throttle/i,
      /rateLimit/i,
      /rateLimiter/i,
      /slowDown/i,
    ],
  ],
  ["cors", [/cors/i, /cross.?origin/i, /Access-Control/i]],
  [
    "validation",
    [
      /zod/i,
      /joi/i,
      /yup/i,
      /validator/i,
      /validate/i,
      /pydantic/i,
      /valibot/i,
    ],
  ],
  [
    "logging",
    [
      /logger/i,
      /morgan/i,
      /pino/i,
      /winston/i,
      /requestLogger/i,
      /httpLogger/i,
    ],
  ],
  [
    "error-handler",
    [
      /errorHandler/i,
      /error.?middleware/i,
      /onError/i,
      /exception.?handler/i,
    ],
  ],
];

function classifyMiddleware(
  name: string,
  content: string
): MiddlewareInfo["type"] {
  const combined = name + " " + content.slice(0, 500);
  for (const [type, patterns] of MIDDLEWARE_PATTERNS) {
    if (patterns.some((p) => p.test(combined))) {
      return type;
    }
  }
  return "custom";
}

export async function detectMiddleware(
  files: string[],
  project: ProjectInfo
): Promise<MiddlewareInfo[]> {
  const middleware: MiddlewareInfo[] = [];

  // Look for middleware files
  const middlewareFiles = files.filter(
    (f) =>
      f.includes("middleware") ||
      f.includes("guard") ||
      f.includes("interceptor") ||
      basename(f).startsWith("auth") ||
      basename(f).includes("rate") ||
      basename(f).includes("cors")
  );

  for (const file of middlewareFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;

    const rel = relative(project.root, file);
    const name = basename(file).replace(/\.[^.]+$/, "");

    middleware.push({
      name,
      file: rel,
      type: classifyMiddleware(name, content),
    });
  }

  // Scan for inline middleware usage in route files
  const routeFiles = files.filter(
    (f) =>
      (f.match(/\.(ts|js|mjs|py|go)$/) &&
        !f.includes("node_modules") &&
        !middlewareFiles.includes(f))
  );

  for (const file of routeFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file);

    // app.use(cors()), app.use(express.json()), app.use("/api", authMw())
    const usePattern = /\.use\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?([\w.]+)\s*[\(,)]/g;
    let match;
    while ((match = usePattern.exec(content)) !== null) {
      const fnName = match[1];
      const type = classifyMiddleware(fnName, "");
      if (type !== "custom") {
        if (!middleware.some((m) => m.name === fnName)) {
          middleware.push({ name: fnName, file: rel, type });
        }
      }
    }

    // Inline route middleware arrays:
    //   router.get('/path', [authMiddleware, validateBody], handler)
    //   router.post('/path', requireAuth, validateInput, handler)
    const inlineArrayPat = /\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*\[([^\]]+)\]/gi;
    while ((match = inlineArrayPat.exec(content)) !== null) {
      const arrayContent = match[2];
      for (const part of arrayContent.split(",")) {
        const mwName = part.trim().replace(/\(.*$/, "");
        if (!mwName || mwName.length < 3) continue;
        const type = classifyMiddleware(mwName, "");
        if (type !== "custom" && !middleware.some((m) => m.name === mwName)) {
          middleware.push({ name: mwName, file: rel, type });
        }
      }
    }

    // Inline middleware without array — router.get('/path', authMiddleware, handler)
    // Detect named functions in the middle argument position (not first, not last)
    const inlineArgsPat = /\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(\w+)\s*,\s*(\w+)/gi;
    while ((match = inlineArgsPat.exec(content)) !== null) {
      // match[2] is the middle arg (middleware), match[3] is the handler
      const mwName = match[2];
      if (!mwName || mwName.length < 3) continue;
      const type = classifyMiddleware(mwName, "");
      if (type !== "custom" && !middleware.some((m) => m.name === mwName)) {
        middleware.push({ name: mwName, file: rel, type });
      }
    }
  }

  // ─── Roku SceneGraph middleware ─────────────────────────────────────────
  //
  // SceneGraph doesn't have HTTP-style middleware, but the closest analog is:
  //   - cross-component observers: `m.top.observeField("x", handler)` and
  //     `m.global.AddField(...)` set up app-wide reactive bindings.
  //   - Bugsnag + Rudderstack telemetry tasks are wired at scene boot, acting
  //     as logging/error-handler middleware for the whole app.
  if (project.frameworks.includes("roku-scenegraph")) {
    const { extractBrightScriptObservers, extractBrightScriptGlobalFields } =
      await import("../ast/extract-brightscript.js");
    const brsFiles = files.filter((f) => f.endsWith(".brs") || f.endsWith(".bs"));

    for (const file of brsFiles) {
      const content = await readFileSafe(file);
      if (!content) continue;
      const rel = relative(project.root, file).replace(/\\/g, "/");

      for (const obs of extractBrightScriptObservers(content)) {
        const name = `observeField(${obs.field}) -> ${obs.handler}`;
        if (middleware.some((m) => m.name === name && m.file === rel)) continue;
        middleware.push({
          name,
          file: rel,
          type: obs.scope === "global" ? "custom" : "custom",
        });
      }

      for (const gf of extractBrightScriptGlobalFields(content)) {
        const name = `m.global.${gf.name}: ${gf.type}`;
        if (middleware.some((m) => m.name === name)) continue;
        middleware.push({ name, file: rel, type: "custom" });
      }

      // Bugsnag + Rudderstack are logging-layer middleware in Roku apps
      if (/bugsnag/i.test(content) && /\bBugsnagTask\b/.test(content)) {
        const name = "BugsnagTask";
        if (!middleware.some((m) => m.name === name)) {
          middleware.push({ name, file: rel, type: "error-handler" });
        }
      }
      if (/RudderstackTask/.test(content)) {
        const name = "RudderstackTask";
        if (!middleware.some((m) => m.name === name)) {
          middleware.push({ name, file: rel, type: "logging" });
        }
      }
    }
  }

  return middleware;
}
