#!/usr/bin/env node
import { initializeMemory, scanStrategies } from "../src/index.js";
const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "memory" && args.length === 3) result = await initializeMemory({ agentId: args[0], directory: args[1], sizeGb: Number(args[2]) });
  else if (command === "scan" && args.length === 1) result = await scanStrategies({ directory: args[0] });
  else if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Aether ATS skills\n\n  aether-ats-skills memory <agent-id> <absolute-directory> <GiB>\n  aether-ats-skills scan <absolute-strategy-directory>\n\nSign in and create synced agents through `aether auth login` and `aether agent create ATS <name>`.\nThis package prepares memory and strategies; it does not authorize or place trades.");
  } else throw new Error("Unknown command. Use aether-ats-skills --help.");
  if (result) { console.log(JSON.stringify(result, null, 2)); if (["unavailable", "error"].includes(result.state)) process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
