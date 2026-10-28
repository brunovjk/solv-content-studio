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

export type AuthRole = "owner" | "partner" | "editor";
export interface AuthIdentity { role: AuthRole; subject: string; }
type PartnerSubject = "partner-1" | "partner-2";

async function signSession(secret: string, identity: AuthIdentity, credentialTag?: string) {
  const payload = encode(encoder.encode(JSON.stringify({expires: Date.now()+86400000, nonce:crypto.randomUUID(), role:identity.role, subject:identity.subject, ...(credentialTag ? {credentialTag} : {})})));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

/** Kept for existing owner/editor callers. Partners always need a verified individual identity. */
export async function createSession(secret: string, role: AuthRole = "owner") {
  if (role !== "owner" && role !== "editor") throw new Error("Papel de acesso inválido.");
  return signSession(secret,{role,subject:role});
}

async function hasEditorCredential(env: Env): Promise<boolean> {
  return Boolean(env.EDITOR_TOKEN && env.EDITOR_TOKEN.length >= 24 && !await sameSecret(env.EDITOR_TOKEN,env.ADMIN_TOKEN!));
}

async function partnerCredential(env: Env, subject: PartnerSubject): Promise<string | null> {
  const credential = subject === "partner-1" ? env.PARTNER_1_TOKEN : env.PARTNER_2_TOKEN;
  const other = subject === "partner-1" ? env.PARTNER_2_TOKEN : env.PARTNER_1_TOKEN;
  if (!credential || credential.length < 24 || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return null;
  // Ambiguous or reused credentials must not silently assign a different identity or role.
  for (const reserved of [env.ADMIN_TOKEN,env.EDITOR_TOKEN,other]) {
    if (reserved && await sameSecret(credential,reserved)) return null;
  }
  return credential;
}

async function fingerprint(credential: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(credential))));
}

/** Issue a signed session after login without exposing a long-lived service or access credential. */
export async function createIdentitySession(env: Env, identity: AuthIdentity): Promise<string> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) throw new Error("Acesso administrativo não configurado.");
  if ((identity.role === "owner" || identity.role === "editor") && identity.subject === identity.role) {
    if (identity.role === "editor" && !await hasEditorCredential(env)) throw new Error("Acesso editorial não configurado.");
    return signSession(env.ADMIN_TOKEN,identity);
  }
  if (identity.role === "partner" && (identity.subject === "partner-1" || identity.subject === "partner-2")) {
    const credential = await partnerCredential(env,identity.subject);
    if (credential) return signSession(env.ADMIN_TOKEN,identity,await fingerprint(credential));
  }
  throw new Error("Identidade de acesso inválida.");
}

async function sessionIdentity(session: string, env: Env): Promise<AuthIdentity | null> {
  try {
    const [payload, signature, extra] = session.split(".");
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify("HMAC", await key(env.ADMIN_TOKEN!), decode(signature), encoder.encode(payload));
    if (!valid) return null;
    const data: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as {expires?: unknown; role?: unknown; subject?: unknown; credentialTag?: unknown};
    if (typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires <= Date.now()) return null;
    // Cookies issued before identity support belonged exclusively to the owner or editor.
    if (value.role === undefined || value.role === "owner") return value.subject === undefined || value.subject === "owner" ? {role:"owner",subject:"owner"} : null;
    if (value.role === "editor" && (value.subject === undefined || value.subject === "editor") && await hasEditorCredential(env)) return {role:"editor",subject:"editor"};
    if (value.role === "partner" && (value.subject === "partner-1" || value.subject === "partner-2") && typeof value.credentialTag === "string") {
      const credential = await partnerCredential(env,value.subject);
      if (credential && await sameSecret(value.credentialTag,await fingerprint(credential))) return {role:"partner",subject:value.subject};
    }
    return null;
  } catch { return null; }
}

/** All identities share the same application data; the credential controls permissions only. */
export async function authenticatedIdentity(request: Request, env: Env): Promise<AuthIdentity | null> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return null;
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    if (!authorization.startsWith("Bearer ")) return null;
    const bearer = authorization.slice(7);
    if (!bearer) return null;
    if (await sameSecret(bearer,env.ADMIN_TOKEN)) return {role:"owner",subject:"owner"};
    for (const subject of ["partner-1","partner-2"] as const) {
      const credential = await partnerCredential(env,subject);
      if (credential && await sameSecret(bearer,credential)) return {role:"partner",subject};
    }
    if (await hasEditorCredential(env) && await sameSecret(bearer,env.EDITOR_TOKEN!)) return {role:"editor",subject:"editor"};
    // An invalid explicit Bearer must never fall back to an owner's ambient cookie.
    return sessionIdentity(bearer,env);
  }
  const session = request.headers.get("Cookie")?.match(/(?:^|;\s*)bot_session=([^;]+)/)?.[1];
  return session ? sessionIdentity(session,env) : null;
}

export async function authenticatedRole(request: Request, env: Env): Promise<AuthRole | null> {
  return (await authenticatedIdentity(request,env))?.role ?? null;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  return (await authenticatedIdentity(request,env)) !== null;
}

export function sessionCookie(request: Request, value: string, clear = false) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `bot_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 86400}${secure}`;
}
