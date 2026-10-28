import { spawnSync } from "node:child_process";
for (const args of [["run","typecheck"],["test"]]) {
  const result = spawnSync("npm",args,{stdio:"inherit"});
  if (result.status !== 0) process.exit(result.status || 1);
}
