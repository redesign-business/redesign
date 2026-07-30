import { attachToSandbox, cleanupSandbox, parseArgs, readRequired, runRedesign } from "./redesign.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = [
  "Usage:",
  "  npm run redesign -- <url> [--slug <slug>]",
  "  npm run attach -- --sandbox <sandbox>",
  "  npm run stop -- --sandbox <sandbox>",
].join("\n");

if (cmd === "help" || rest.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const { args, positional } = parseArgs(rest);

try {
  if (cmd === "redesign") {
    const site = positional[0] ?? args.get("site");
    if (!site) throw new Error("Missing site URL");

    await runRedesign({
      site,
      slug: args.get("slug"),
      timeoutMinutes: args.has("timeout") ? Number(args.get("timeout")) : undefined,
    });
  } else if (cmd === "attach") {
    const sandbox = args.get("sandbox") ?? positional[0];
    if (!sandbox) throw new Error("Missing --sandbox");
    await attachToSandbox(sandbox);
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
