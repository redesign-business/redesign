import { attachToSandbox, backfillBusinessContacts, cleanupSandbox, deleteWebsite, parseArgs, readRequired, runRedesign } from "./redesign.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = [
  "Usage:",
  "  npm run redesign -- <url> [--slug <slug>] [--business <name>] [--business-slug <slug>]",
  "  npm run backfill-contacts",
  "  npm run delete -- --slug <slug>",
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
      business: args.get("business"),
      businessSlug: args.get("business-slug"),
      slug: args.get("slug"),
      timeoutMinutes: args.has("timeout") ? Number(args.get("timeout")) : undefined,
    });
  } else if (cmd === "attach") {
    const sandbox = args.get("sandbox") ?? positional[0];
    if (!sandbox) throw new Error("Missing --sandbox");
    await attachToSandbox(sandbox);
  } else if (cmd === "delete") {
    const result = await deleteWebsite(readRequired(args, "slug"));
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "backfill-contacts") {
    const results = await backfillBusinessContacts();
    const failed = results.filter((result) => result.error).length;
    console.log(`Backfilled ${results.length - failed}/${results.length} businesses; ${failed} failed.`);
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
