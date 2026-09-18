#!/usr/bin/env node
import { initializeMemory, scanStrategies, listBundledStrategies, installBundledStrategies, readJournal, formatJournal } from "../src/index.js";
const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "memory" && args.length === 3) result = await initializeMemory({ agentId: args[0], directory: args[1], sizeGb: Number(args[2]) });
  else if (command === "scan" && args.length === 1) result = await scanStrategies({ directory: args[0] });
  else if (command === "library" && args[0] === "list" && args.length <= 2) result = await listBundledStrategies(args[1] ? { category: args[1] } : {});
  else if (command === "library" && args[0] === "install" && args.length === 3 && ["starter", "all"].includes(args[1])) result = await installBundledStrategies({ directory: args[2], selection: args[1] });
  else if (command === "journal" && args[0] === "dump" && args.length >= 2 && args.length <= 4) {
    const json = args.includes("--json");
    const values = args.slice(2).filter(value => value !== "--json");
    if (values.length > 1 || (values[0] && !/^\d+$/.test(values[0]))) throw new Error("Journal limit must be a whole number from 1 to 500.");
    console.log(formatJournal(await readJournal(args[1], { limit: values[0] ? Number(values[0]) : 100 }), { json }).trimEnd());
  }
  else if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Aether ATS skills\n\n  aether-ats-skills memory <agent-id> <absolute-directory> <GiB>\n  aether-ats-skills scan <absolute-strategy-directory>\n  aether-ats-skills library list [category]\n  aether-ats-skills library install starter|all <absolute-strategy-directory>\n  aether-ats-skills journal dump <absolute-journal-file> [limit] [--json]\n\nSign in and create synced agents through `aether auth login` and `aether agent create ATS <name>`.\nThis package prepares memory and strategies; it does not authorize or place trades.");
  } else throw new Error("Unknown command. Use aether-ats-skills --help.");
  if (result) { console.log(JSON.stringify(result, null, 2)); if (["unavailable", "error"].includes(result.state)) process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
