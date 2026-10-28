import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

if (!process.stdin.isTTY) {
  console.error("Execute npm run configure em um terminal interativo.");
  process.exit(1);
}
const file = ".dev.vars";
const current = existsSync(file) ? readFileSync(file,"utf8") : "";
const values = Object.fromEntries(current.split("\n").filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{
  const i=line.indexOf("="); return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,"")];
}));
values.ADMIN_TOKEN ||= randomBytes(24).toString("base64url");
values.DEMO_MODE ||= "true";

function secret(label) {
  process.stdout.write(label+" (Enter mantém o atual): ");
  return new Promise(resolve=>{
    let value="";
    process.stdin.setRawMode(true); process.stdin.resume();
    const finish=()=>{process.stdin.off("data",onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write("\n");resolve(value);};
    const onData=chunk=>{
      for (const char of chunk.toString()) {
        if (char==="\u0003") {process.stdin.setRawMode(false);process.stdout.write("\n");process.exit(130);}
        if (char==="\r"||char==="\n") {finish();return;}
        if (char==="\u007f"||char==="\b") value=value.slice(0,-1);
        else if (char>=" ") value+=char;
      }
    };
    process.stdin.on("data",onData);
  });
}
console.log("\nConfiguração local — os segredos ficam somente em .dev.vars.\n");
for (const [name,label] of [["GEMINI_API_KEY","Chave Gemini"],["BUFFER_API_KEY","Chave Buffer (opcional agora)"],["CF_BROWSER_API_TOKEN","Token Cloudflare Browser Run (opcional agora)"]]) {
  const value=await secret(label); if(value) values[name]=value;
}
const rl=createInterface({input:process.stdin,output:process.stdout});
for (const [name,label] of [["CF_ACCOUNT_ID","Cloudflare Account ID"],["PUBLIC_BASE_URL","URL pública HTTPS do bot"]]) {
  const value=(await rl.question(label+" (Enter mantém): ")).trim();if(value)values[name]=value;
}
rl.close();
writeFileSync(file,Object.entries(values).map(([name,value])=>`${name}=${JSON.stringify(value)}`).join("\n")+"\n",{mode:0o600});
chmodSync(file,0o600);
console.log("\nConfiguração salva. Reinicie npm run dev para carregar as chaves.");
console.log("O teste local continua sem envio externo. Para publicar, siga o README.");
