import { relative, basename, extname } from "node:path";
import { readFileSafe } from "../scanner.js";
import { loadTypeScript } from "../ast/loader.js";
import { extractReactComponentsAST } from "../ast/extract-components.js";
import { extractFlutterWidgets } from "../ast/extract-dart.js";
import { extractSwiftUIViews } from "../ast/extract-swift.js";
import type { ComponentInfo, ProjectInfo } from "../types.js";

// shadcn/ui + radix primitives to filter out
const UI_PRIMITIVES = new Set([
  "accordion",
  "alert",
  "alert-dialog",
  "aspect-ratio",
  "avatar",
  "badge",
  "breadcrumb",
  "button",
  "calendar",
  "card",
  "carousel",
  "chart",
  "checkbox",
  "collapsible",
  "command",
  "context-menu",
  "data-table",
  "date-picker",
  "dialog",
  "drawer",
  "dropdown-menu",
  "form",
  "hover-card",
  "input",
  "input-otp",
  "label",
  "menubar",
  "navigation-menu",
  "pagination",
  "popover",
  "progress",
  "radio-group",
  "resizable",
  "scroll-area",
  "select",
  "separator",
  "sheet",
  "sidebar",
  "skeleton",
  "slider",
  "sonner",
  "switch",
  "table",
  "tabs",
  "textarea",
  "toast",
  "toaster",
  "toggle",
  "toggle-group",
  "tooltip",
]);

function isUIPrimitive(filePath: string): boolean {
  const name = basename(filePath, extname(filePath)).toLowerCase();
  return (
    UI_PRIMITIVES.has(name) ||
    filePath.includes("/ui/") ||
    filePath.includes("/components/ui/") ||
    filePath.includes("@radix-ui") ||
    filePath.includes("@shadcn")
  );
}

export async function detectComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  switch (project.componentFramework) {
    case "react":
      return detectReactComponents(files, project);
    case "vue":
      return detectVueComponents(files, project);
    case "svelte":
      return detectSvelteComponents(files, project);
    case "flutter":
      return detectFlutterComponents(files, project);
    default: {
      // SwiftUI: no componentFramework flag — detect if swiftui/vapor framework present
      if (
        project.frameworks.includes("swiftui") ||
        project.frameworks.includes("vapor")
      ) {
        return detectSwiftUIComponents(files, project);
      }
      return [];
    }
  }
}

// --- React ---
async function detectReactComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  const componentFiles = files.filter(
    (f) =>
      (f.endsWith(".tsx") || f.endsWith(".jsx")) &&
      !f.includes("node_modules") &&
      !f.endsWith(".test.tsx") &&
      !f.endsWith(".test.jsx") &&
      !f.endsWith(".spec.tsx") &&
      !f.endsWith(".spec.jsx") &&
      !f.endsWith(".stories.tsx") &&
      !f.endsWith(".stories.jsx")
  );

  const components: ComponentInfo[] = [];
  const ts = loadTypeScript(project.root);

  for (const file of componentFiles) {
    if (isUIPrimitive(file)) continue;

    const content = await readFileSafe(file);
    if (!content) continue;

    const rel = relative(project.root, file);

    // Try AST first — extracts prop types, handles forwardRef/memo
    if (ts) {
      const astComponents = extractReactComponentsAST(ts, file, content, rel);
      if (astComponents.length > 0) {
        components.push(...astComponents);
        continue;
      }
    }

    // Detect component name from export
    let name = "";

    // export default function ComponentName
    const defaultFnMatch = content.match(
      /export\s+default\s+function\s+(\w+)/
    );
    if (defaultFnMatch) {
      name = defaultFnMatch[1];
    }

    // export function ComponentName (starts with uppercase)
    if (!name) {
      const namedFnMatch = content.match(
        /export\s+(?:async\s+)?function\s+([A-Z]\w+)/
      );
      if (namedFnMatch) name = namedFnMatch[1];
    }

    // const ComponentName = ... (with export)
    if (!name) {
      const constMatch = content.match(
        /export\s+const\s+([A-Z]\w+)\s*(?::\s*\w+)?\s*=/
      );
      if (constMatch) name = constMatch[1];
    }

    // Fallback: any function starting with uppercase that returns JSX
    if (!name) {
      const anyComponent = content.match(
        /(?:function|const)\s+([A-Z]\w+)/
      );
      if (anyComponent && (content.includes("<") || content.includes("jsx"))) {
        name = anyComponent[1];
      }
    }

    if (!name) continue;

    // Detect props
    const props: string[] = [];

    // interface/type Props { ... }
    const propsPattern =
      /(?:interface|type)\s+(?:\w*Props\w*)\s*(?:=\s*)?\{([^}]*)}/;
    const propsMatch = content.match(propsPattern);
    if (propsMatch) {
      const propsBody = propsMatch[1];
      for (const line of propsBody.split("\n")) {
        const propMatch = line.match(/^\s*(\w+)\s*[?]?\s*:/);
        if (propMatch && propMatch[1] !== "children") {
          props.push(propMatch[1]);
        }
      }
    }

    // Destructured props: function Component({ prop1, prop2 }: Props)
    if (props.length === 0) {
      const destructuredMatch = content.match(
        new RegExp(`function\\s+${name}\\s*\\(\\s*\\{([^}]*)\\}`)
      );
      if (destructuredMatch) {
        for (const prop of destructuredMatch[1].split(",")) {
          const trimmed = prop.trim().split(/[=:]/)[0].trim();
          if (trimmed && trimmed !== "children" && !trimmed.startsWith("...")) {
            props.push(trimmed);
          }
        }
      }
    }

    const isClient = content.slice(0, 50).includes("use client");
    const isServer = content.slice(0, 50).includes("use server");

    components.push({
      name,
      file: rel,
      props: props.slice(0, 10), // limit to 10 props
      isClient,
      isServer,
    });
  }

  return components;
}

// --- Vue ---
async function detectVueComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  const vueFiles = files.filter(
    (f) => f.endsWith(".vue") && !f.includes("node_modules")
  );
  const components: ComponentInfo[] = [];

  for (const file of vueFiles) {
    if (isUIPrimitive(file)) continue;

    const content = await readFileSafe(file);
    const rel = relative(project.root, file);
    const name = basename(file, ".vue");

    const props: string[] = [];

    // defineProps<{ ... }>() or defineProps({ ... })
    const definePropsMatch = content.match(/defineProps\s*[<(]\s*\{([^}]*)\}/);
    if (definePropsMatch) {
      for (const line of definePropsMatch[1].split("\n")) {
        const propMatch = line.match(/^\s*(\w+)\s*[?]?\s*:/);
        if (propMatch) props.push(propMatch[1]);
      }
    }

    // props: { ... } in Options API
    if (props.length === 0) {
      const optionsPropsMatch = content.match(/props\s*:\s*\{([^}]*)\}/);
      if (optionsPropsMatch) {
        for (const line of optionsPropsMatch[1].split("\n")) {
          const propMatch = line.match(/^\s*(\w+)\s*[?]?\s*:/);
          if (propMatch) props.push(propMatch[1]);
        }
      }
    }

    components.push({
      name,
      file: rel,
      props: props.slice(0, 10),
      isClient: true,
      isServer: false,
    });
  }

  return components;
}

// --- Svelte ---
async function detectSvelteComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  const svelteFiles = files.filter(
    (f) => f.endsWith(".svelte") && !f.includes("node_modules")
  );
  const components: ComponentInfo[] = [];

  for (const file of svelteFiles) {
    if (isUIPrimitive(file)) continue;

    const content = await readFileSafe(file);
    const rel = relative(project.root, file);
    const name = basename(file, ".svelte");

    const props: string[] = [];

    // export let propName (Svelte 4)
    const exportLetPattern = /export\s+let\s+(\w+)/g;
    let match;
    while ((match = exportLetPattern.exec(content)) !== null) {
      props.push(match[1]);
    }

    // $props() (Svelte 5)
    const propsMatch = content.match(/let\s+\{([^}]*)\}\s*=\s*\$props\(\)/);
    if (propsMatch) {
      for (const prop of propsMatch[1].split(",")) {
        const trimmed = prop.trim().split(/[=:]/)[0].trim();
        if (trimmed && !trimmed.startsWith("...")) {
          props.push(trimmed);
        }
      }
    }

    components.push({
      name,
      file: rel,
      props: props.slice(0, 10),
      isClient: true,
      isServer: false,
    });
  }

  return components;
}

// --- Flutter Widgets ---
async function detectFlutterComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  const dartFiles = files.filter(
    (f) => f.endsWith(".dart") && !f.includes("_test.dart") && !f.includes(".g.dart")
  );
  const components: ComponentInfo[] = [];

  for (const file of dartFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    const rel = relative(project.root, file);
    components.push(...extractFlutterWidgets(rel, content));
  }

  return components;
}

// --- SwiftUI Views ---
async function detectSwiftUIComponents(
  files: string[],
  project: ProjectInfo
): Promise<ComponentInfo[]> {
  const swiftFiles = files.filter(
    (f) => f.endsWith(".swift") && !f.includes("Tests/") && !f.includes("_test.swift")
  );
  const components: ComponentInfo[] = [];

  for (const file of swiftFiles) {
    const content = await readFileSafe(file);
    if (!content) continue;
    if (!content.includes(": View") && !content.includes(":View")) continue;
    const rel = relative(project.root, file);
    components.push(...extractSwiftUIViews(rel, content));
  }

  return components;
}
