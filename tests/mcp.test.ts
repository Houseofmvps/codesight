import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const entrypoint = resolve(projectRoot, "dist/index.js");

function startServer() {
  return spawn("node", [entrypoint, "--mcp"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readFramedResponse(child: ReturnType<typeof startServer>, timeoutMs = 1500) {
  const stdout = child.stdout;
  if (!stdout) throw new Error("stdout unavailable");

  return await new Promise<any>((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`MCP process exited before response (code=${code}, signal=${signal})`));
    }

    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        cleanup();
        reject(new Error(`Missing Content-Length header: ${header}`));
        return;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;

      const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      cleanup();
      resolvePromise(JSON.parse(body));
    }

    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function readLineResponse(child: ReturnType<typeof startServer>, timeoutMs = 1500) {
  const stdout = child.stdout;
  if (!stdout) throw new Error("stdout unavailable");

  return await new Promise<any>((resolvePromise, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for newline MCP response after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`MCP process exited before line response (code=${code}, signal=${signal})`));
    }

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      cleanup();
      resolvePromise(JSON.parse(line));
    }

    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function writeFramedMessage(child: ReturnType<typeof startServer>, payload: unknown) {
  const input = child.stdin;
  if (!input) throw new Error("stdin unavailable");
  const body = JSON.stringify(payload);
  input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function writeLineMessage(child: ReturnType<typeof startServer>, payload: unknown) {
  const input = child.stdin;
  if (!input) throw new Error("stdin unavailable");
  input.write(`${JSON.stringify(payload)}\n`);
}

async function stopServer(child: ReturnType<typeof startServer>) {
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => child.once("exit", () => resolvePromise(undefined)));
}

test("MCP server responds to Content-Length framed initialize", async () => {
  const child = startServer();
  try {
    writeFramedMessage(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const response = await readFramedResponse(child);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result?.serverInfo?.name, "codesight");
  } finally {
    await stopServer(child);
  }
});

test("MCP server responds to newline-delimited initialize used by Claude health checks", async () => {
  const child = startServer();
  try {
    writeLineMessage(child, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {
          roots: {},
          elicitation: {},
        },
        clientInfo: {
          name: "claude-code",
          title: "Claude Code",
          version: "2.1.96",
          description: "Anthropic's agentic coding tool",
          websiteUrl: "https://claude.com/claude-code",
        },
      },
    });

    const response = await readLineResponse(child);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 0);
    assert.equal(response.result?.serverInfo?.name, "codesight");
  } finally {
    await stopServer(child);
  }
});
