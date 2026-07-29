import { spawn } from "node:child_process";
import { cleanupSandbox, commandOutput, continueRedesign, parseArgs, readRequired, refreshUsage, runHybridRedesign, runRedesign } from "./redesign.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = [
  "Usage:",
  "  npm run redesign <url> [--slug <slug>] [--model <model>] [--agent-id <id>] [--keep-sandbox]",
  "  npm run hybrid <url> [--slug <slug>] [--research-model <model>] [--build-model <model>] [--agent-id <id>] [--keep-sandbox]",
  "  npm run continue -- --metrics <path> [--agent-id <id>]",
  "  npm run logs -- --sandbox <sandbox> --command <command>",
  "  npm run stop -- --sandbox <sandbox>",
  "  npm run usage -- --metrics <path>",
].join("\n");

if (cmd === "help" || rest.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const { args, positional } = parseArgs(rest);
const agentId = args.get("agent-id");

if ((cmd === "redesign" || cmd === "start" || cmd === "hybrid" || cmd === "continue") && agentId && process.env.REDESIGN_AGENT_SUBPROCESS !== "1") {
  const script = cmd === "start" ? "redesign" : cmd;
  const child = spawn("npm", ["run", script, "--", ...rest], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, REDESIGN_AGENT_SUBPROCESS: "1" },
    stdio: "ignore",
  });
  child.unref();
  console.log(`Subscribed ${script} job started.`);
  console.log(`Agent: ${agentId}`);
  process.exit(0);
}

try {
  if (cmd === "redesign" || cmd === "start") {
    const site = positional[0] ?? args.get("site");
    if (!site) throw new Error("Missing site URL");

    await runRedesign({
      site,
      slug: args.get("slug"),
      model: args.get("model"),
      keepSandbox: args.get("keep-sandbox") === "true",
      agentId,
      timeoutMinutes: args.has("timeout") ? Number(args.get("timeout")) : undefined,
    });
  } else if (cmd === "hybrid") {
    const site = positional[0] ?? args.get("site");
    if (!site) throw new Error("Missing site URL");

    await runHybridRedesign({
      site,
      slug: args.get("slug"),
      researchModel: args.get("research-model"),
      buildModel: args.get("build-model"),
      keepSandbox: args.get("keep-sandbox") === "true",
      agentId,
      timeoutMinutes: args.has("timeout") ? Number(args.get("timeout")) : undefined,
    });
  } else if (cmd === "logs") {
    console.log(await commandOutput(readRequired(args, "sandbox"), readRequired(args, "command")));
  } else if (cmd === "continue") {
    await continueRedesign(readRequired(args, "metrics"), { agentId });
  } else if (cmd === "usage") {
    await refreshUsage(readRequired(args, "metrics"));
  } else if (cmd === "stop") {
    await cleanupSandbox(readRequired(args, "sandbox"));
    console.log("Sandbox deleted.");
  } else {
    console.log(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
