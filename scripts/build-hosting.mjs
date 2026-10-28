import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dashboardHtml } from "../src/dashboard.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
if (!apiBaseUrl) throw new Error("Configure PUBLIC_API_BASE_URL com a origem HTTPS do Worker antes de gerar o painel Firebase.");
const api = new URL(apiBaseUrl);
if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.pathname !== "/") throw new Error("PUBLIC_API_BASE_URL exige uma origem HTTPS sem caminhos, credenciais ou parâmetros.");
mkdirSync("dist", {recursive:true});
writeFileSync("dist/index.html", dashboardHtml({apiBaseUrl:api.origin}));
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#080b12"/><path d="m23 16 19 16-19 16" fill="none" stroke="#64b5ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
writeFileSync("dist/favicon.svg", favicon);
writeFileSync("firebase.json", JSON.stringify({
  hosting:{public:"dist",ignore:["firebase.json","**/.*","**/node_modules/**"],rewrites:[{source:"**",destination:"/index.html"}],headers:[
    {source:"**",headers:[
      {key:"X-Content-Type-Options",value:"nosniff"},
      {key:"X-Frame-Options",value:"DENY"},
      {key:"Referrer-Policy",value:"no-referrer"},
      {key:"X-Robots-Tag",value:"noindex, nofollow"},
      {key:"Permissions-Policy",value:"camera=(), microphone=(), geolocation=()"},
      {key:"Content-Security-Policy",value:`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${api.origin}; connect-src 'self' ${api.origin}; frame-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`}
    ]},
    {source:"/index.html",headers:[{key:"Cache-Control",value:"no-store"}]},
    {source:"/",headers:[{key:"Cache-Control",value:"no-store"}]}
  ]}
}, null, 2)+"\n");
console.log("Painel Solv Studio gerado em dist/. A configuração pública contém apenas o endereço da API; nenhuma chave foi incluída.");
