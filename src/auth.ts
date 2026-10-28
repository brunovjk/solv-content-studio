import type { Env } from "./types.ts";

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const encoder = new TextEncoder();

export async function sameSecret(a: string, b: string) {
  const [ah,bh] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const left = new Uint8Array(ah), right = new Uint8Array(bh);
  let diff = 0;
  for (let i=0;i<left.length;i++) diff |= left[i]^right[i];
  return diff === 0;
}

async function key(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
}

export type AuthRole = "owner" | "editor";

export async function createSession(secret: string, role: AuthRole = "owner") {
  if (role !== "owner" && role !== "editor") throw new Error("Papel de acesso inválido.");
  const payload = encode(encoder.encode(JSON.stringify({expires: Date.now()+86400000, nonce:crypto.randomUUID(), role})));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

async function hasEditorCredential(env: Env): Promise<boolean> {
  return Boolean(env.EDITOR_TOKEN && env.EDITOR_TOKEN.length >= 24 && !await sameSecret(env.EDITOR_TOKEN,env.ADMIN_TOKEN!));
}

async function sessionRole(session: string, env: Env): Promise<AuthRole | null> {
  try {
    const [payload, signature, extra] = session.split(".");
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify("HMAC", await key(env.ADMIN_TOKEN!), decode(signature), encoder.encode(payload));
    if (!valid) return null;
    const data: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as {expires?: unknown; role?: unknown};
    if (typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires <= Date.now()) return null;
    // Cookies issued before role support belonged exclusively to the owner.
    if (value.role === undefined || value.role === "owner") return "owner";
    if (value.role === "editor" && await hasEditorCredential(env)) return "editor";
    return null;
  } catch { return null; }
}

/** Master credentials remain server-side login inputs; browsers can use short-lived signed sessions. */
export async function authenticatedRole(request: Request, env: Env): Promise<AuthRole | null> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return null;
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    if (!authorization.startsWith("Bearer ")) return null;
    const bearer = authorization.slice(7);
    if (!bearer) return null;
    if (await sameSecret(bearer,env.ADMIN_TOKEN)) return "owner";
    if (await hasEditorCredential(env) && await sameSecret(bearer,env.EDITOR_TOKEN!)) return "editor";
    // An invalid explicit Bearer must never fall back to an owner's ambient cookie.
    return sessionRole(bearer,env);
  }
  const session = request.headers.get("Cookie")?.match(/(?:^|;\s*)bot_session=([^;]+)/)?.[1];
  return session ? sessionRole(session,env) : null;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  return (await authenticatedRole(request,env)) !== null;
}

export function sessionCookie(request: Request, value: string, clear = false) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `bot_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 86400}${secure}`;
}
