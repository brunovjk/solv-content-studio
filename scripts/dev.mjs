import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

if (!existsSync(".dev.vars")) {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(".dev.vars", `ADMIN_TOKEN=${token}\nDEMO_MODE=true\nGEMINI_API_KEY=\nBUFFER_API_KEY=\nCF_ACCOUNT_ID=\nCF_BROWSER_API_TOKEN=\nPUBLIC_BASE_URL=\n`, {mode:0o600});
}
const config = readFileSync(".dev.vars","utf8");
const token = config.match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.replace(/^["']|["']$/g,"");
if (!token || token.length < 24) {
  console.error("Defina ADMIN_TOKEN com pelo menos 24 caracteres em .dev.vars.");
  process.exit(1);
}
const wrangler = "node_modules/wrangler/bin/wrangler.js";
const migrations = spawnSync(process.execPath,[wrangler,"d1","migrations","apply","DB","--local"],{stdio:"inherit"});
if (migrations.status !== 0) process.exit(migrations.status || 1);
console.log("\nPainel: http://localhost:8787");
console.log("A chave de acesso está em .dev.vars (campo ADMIN_TOKEN).\n");
let child;
let stopping = false;
let restartRequested = false;
function startServer() {
  child = spawn(process.execPath,[wrangler,"dev","--port","8787","--ip","127.0.0.1"],{stdio:"inherit"});
  child.on("exit",code=>{
    if (restartRequested && !stopping) {
      restartRequested=false;
      startServer();
    } else {
      unwatchFile(".dev.vars");
      process.exit(code || 0);
    }
  });
}
function stop(signal) {
  stopping=true;
  unwatchFile(".dev.vars");
  child?.kill(signal);
}
process.on("SIGINT",()=>stop("SIGINT"));
process.on("SIGTERM",()=>stop("SIGTERM"));
watchFile(".dev.vars",{interval:500},(current,previous)=>{
  if (stopping || current.mtimeMs === previous.mtimeMs) return;
  if (!restartRequested) {
    console.log("\nConfiguração atualizada. Recarregando o servidor…");
    restartRequested=true;
    child?.kill("SIGINT");
  }
});
startServer();
