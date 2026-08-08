import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

const RELUME_URL = "https://relume-library-mcp.relume.io/mcp";
const RELUME_AUTH = "/home/vercel-sandbox/.local/share/opencode/mcp-auth.json";

type McpResponse = {
  error?: { code?: number; message?: string };
  result?: unknown;
};

type RelumeToolResult = {
  content?: Array<{ type?: string; text?: string }>;
};

export type RelumeInstall = {
  slugs: string[];
  files: Array<{ path: string; sourceSha256: string; sha256: string; compatibilityEdits: number }>;
  dependencies: string[];
};

function responseJson(body: string): McpResponse {
  if (!body.trim()) return {};
  if (!body.startsWith("event:")) return JSON.parse(body) as McpResponse;
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  if (!data) throw new Error("Relume MCP returned an empty event stream");
  return JSON.parse(data.slice(5).trim()) as McpResponse;
}

async function accessToken(authPath: string) {
  const auth = JSON.parse(await readFile(authPath, "utf8")) as {
    "relume-library"?: { tokens?: { accessToken?: string } };
  };
  const token = auth["relume-library"]?.tokens?.accessToken;
  if (!token) throw new Error("Relume MCP authentication is unavailable");
  return token;
}

async function callRelumeTool(name: string, args: Record<string, unknown>, authPath = RELUME_AUTH) {
  const token = await accessToken(authPath);
  let sessionId: string | null = null;
  let requestId = 0;

  const send = async (method: string, params?: unknown, notification = false) => {
    const response = await fetch(RELUME_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++requestId }), method, ...(params === undefined ? {} : { params }) }),
    });
    if (!response.ok) throw new Error(`Relume MCP ${method} failed: ${response.status} ${await response.text()}`);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (notification) return undefined;
    const json = responseJson(await response.text());
    if (json.error) throw new Error(`Relume MCP ${method} failed: ${json.error.message ?? json.error.code ?? "unknown error"}`);
    return json.result;
  };

  try {
    await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "redesign-hosted-2", version: "0.1.0" },
    });
    await send("notifications/initialized", undefined, true);
    return await send("tools/call", {
      name,
      arguments: args,
    });
  } finally {
    if (sessionId) {
      await fetch(RELUME_URL, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
      }).catch(() => {});
    }
  }
}

export function firstRelumeSlug(result: unknown) {
  if (result && typeof result === "object" && "isError" in result && result.isError) {
    const message = (result as RelumeToolResult).content?.find((item) => item.text)?.text;
    throw new Error(`Relume search failed${message ? `: ${message}` : ""}`);
  }
  const structured: string[] = [];
  const textCandidates: string[] = [];
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      if (key?.toLowerCase() === "slug") structured.push(value);
      const firstResult = value.match(/^\s*-\s+([a-z0-9][a-z0-9_-]*)\s+—/im)?.[1];
      if (firstResult) textCandidates.push(firstResult);
      for (const match of value.matchAll(/\b(?:section_[a-z0-9_]+|(?:navbar|footer)\d+_component)\b/gi)) textCandidates.push(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(result);
  const slug = [...structured, ...textCandidates].find((candidate) => /^[a-z0-9][a-z0-9_-]*$/i.test(candidate));
  if (!slug) throw new Error("Relume search returned no component slug");
  return slug.toLowerCase();
}

export async function searchRelumeComponent(query: string, authPath = RELUME_AUTH) {
  return callRelumeTool("search_components", { query, category: "", limit: 1 }, authPath);
}

export async function getRelumeComponents(slugs: string[], authPath = RELUME_AUTH) {
  return callRelumeTool("get_components", {
    slugs,
    primitives: "include",
    aliases: { ui: "@/components/ui", hooks: "@/hooks", lib: "@/lib" },
    have: ["button", "cn", "use-media-query"],
  }, authPath);
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function parseRelumeComponents(result: unknown) {
  const texts = ((result as RelumeToolResult | undefined)?.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text ?? "");
  const files = new Map<string, string>();
  const dependencies = new Set<string>();

  for (const text of texts) {
    for (const match of text.matchAll(/^\/\/ File: ([^\n]+)\n```[^\n]*\n([\s\S]*?)^```/gm)) {
      const supplied = match[1].trim();
      const path = supplied.includes("/") ? normalize(supplied) : `components/relume/${supplied}`;
      if (isAbsolute(path) || path === ".." || path.startsWith("../")) throw new Error(`Unsafe Relume file path: ${supplied}`);
      const content = `${match[2].replace(/\s+$/, "")}\n`;
      const previous = files.get(path);
      if (previous && previous !== content) throw new Error(`Relume returned conflicting content for ${path}`);
      files.set(path, content);
    }
    for (const match of text.matchAll(/^npm i (.+)$/gm)) {
      for (const dependency of match[1].trim().split(/\s+/)) dependencies.add(dependency);
    }
  }

  if (!files.size) throw new Error("Relume returned no component files");
  return { files: [...files].map(([path, content]) => ({ path, content })), dependencies: [...dependencies] };
}

export function applyRelumeCompatibility(content: string) {
  const variants = content.includes('from "motion/react"') ? [...content.matchAll(/const\s+\w+Variants\s*=\s*\{/g)] : [];
  let compatible = variants.length ? content.replace(/const\s+(\w+Variants)\s*=\s*\{/g, "const $1: Variants = {") : content;
  if (variants.length && !/import\s*{[^}]*\bVariants\b[^}]*}\s*from\s*"motion\/react";/s.test(content)) {
    compatible = compatible.replace(/import\s*{[^}]*}\s*from\s*"motion\/react";/s, (statement) => statement.replace("{", "{ type Variants,"));
  }
  const logos = compatible.match(/<img\b[^>]*\bsrc=\{logo\.src\}[^>]*\/>/g) ?? [];
  let logoEdits = 0;
  for (const logo of logos) {
    if (logo.includes("h-6 w-auto max-w-[70vw] md:h-8")) continue;
    if (/\bclassName="/.test(logo)) {
      compatible = compatible.replace(logo, logo.replace(/\bclassName="([^"]*)"/, 'className="$1 h-6 w-auto max-w-[70vw] md:h-8"'));
    } else {
      compatible = compatible.replace(logo, logo.replace("<img", '<img className="h-6 w-auto max-w-[70vw] md:h-8"'));
    }
    logoEdits += 1;
  }
  return { content: compatible, edits: variants.length + logoEdits };
}

export function relumeComponentApi(path: string, content: string) {
  const component = content.search(/^export (?:const|function) [A-Z]/m);
  if (component === -1) throw new Error(`Relume component export not found in ${path}`);
  const signatureEnd = content.indexOf("\n", component);
  return `## ${path}\n\n\`\`\`tsx\n${content.slice(0, signatureEnd === -1 ? content.length : signatureEnd).trim()}\n\`\`\`\n`;
}

export function relumeApiForSlug(api: string, slug: string) {
  const componentName = slug.replace(/^section_/, "").replace(/_component$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const blocks = api.split(/(?=^## )/m);
  const block = blocks.find((candidate) => {
    const path = candidate.match(/^## (.+)$/m)?.[1];
    return path?.split("/").at(-1)?.replace(/\.tsx$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase() === componentName;
  });
  if (!block) throw new Error(`Relume prop API not found for ${slug}`);
  return block.trim();
}

export async function installRelumeComponents(workdir: string, slugs: string[], authPath = RELUME_AUTH) {
  const raw = await getRelumeComponents(slugs, authPath);
  const parsed = parseRelumeComponents(raw);
  const installed: RelumeInstall["files"] = [];
  const api: string[] = [];

  await mkdir(`${workdir}/.redesign`, { recursive: true });
  await writeFile(`${workdir}/.redesign/relume-components.json`, `${JSON.stringify(raw, null, 2)}\n`);
  for (const file of parsed.files) {
    const path = `${workdir}/${file.path}`;
    const isSection = file.path.startsWith("components/relume/");
    const preserveExisting = file.path === "components/ui/button.tsx" || file.path === "lib/utils.ts" || file.path === "hooks/use-media-query.ts";
    if (preserveExisting) {
      try {
        await readFile(path);
        continue;
      } catch {}
    }
    const compatible = applyRelumeCompatibility(file.content);
    if (isSection) {
      api.push(relumeComponentApi(file.path, file.content));
    }
    const originalPath = `${workdir}/.redesign/relume-original/${file.path}`;
    await mkdir(dirname(originalPath), { recursive: true });
    await writeFile(originalPath, file.content);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, compatible.content);
    installed.push({
      path: file.path,
      sourceSha256: sha256(file.content),
      sha256: sha256(compatible.content),
      compatibilityEdits: compatible.edits,
    });
  }

  api.unshift(relumeComponentApi("components/ui/button.tsx", await readFile(`${workdir}/components/ui/button.tsx`, "utf8")));

  const manifest = { slugs, files: installed, dependencies: parsed.dependencies } satisfies RelumeInstall;
  await writeFile(`${workdir}/.redesign/relume-api.md`, `${api.join("\n").trim()}\n`);
  await writeFile(`${workdir}/.redesign/relume-install.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyRelumeComponents(workdir: string, install: RelumeInstall) {
  const changed: string[] = [];
  for (const file of install.files) {
    const content = await readFile(`${workdir}/${file.path}`, "utf8");
    if (sha256(content) !== file.sha256) changed.push(file.path);
  }
  if (changed.length) throw new Error(`Build agent edited installed Relume files: ${changed.join(", ")}`);
}
