import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedIdentity, authenticatedRole, createIdentitySession, createSession, isAuthenticated, sameSecret, sessionCookie } from "../src/auth.ts";
import type { Env } from "../src/types.ts";

const secret = "test-admin-secret-at-least-24-characters";
const env = { ADMIN_TOKEN: secret } as Env;
const req = (headers: Record<string, string> = {}) => new Request("https://bot.example.com/api/posts", { headers });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
async function signedSession(expires: unknown, role?: unknown, signingSecret = secret) {
  const payload = b64(new TextEncoder().encode(JSON.stringify({ expires, nonce: "test", ...(role === undefined ? {} : { role }) })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64(new Uint8Array(signature))}`;
}

test("authentication denies absent, empty and short admin secrets", async () => {
  for (const token of [undefined, "", "short"]) {
    assert.equal(await isAuthenticated(req({ Authorization: `Bearer ${token || ""}` }), { ADMIN_TOKEN: token } as Env), false);
    assert.equal(await isAuthenticated(req(), { ADMIN_TOKEN: token } as Env), false);
  }
});

test("only the exact Bearer token authenticates", async () => {
  assert.equal(await isAuthenticated(req({ Authorization: `Bearer ${secret}` }), env), true);
  assert.equal(await isAuthenticated(req({ Authorization: `Bearer ${secret}x` }), env), false);
  assert.equal(await isAuthenticated(req({ Authorization: "Bearer " }), env), false);
  assert.equal(await isAuthenticated(req({ Authorization: `Basic ${secret}` }), env), false);
  assert.equal(await sameSecret(secret, secret), true);
  assert.equal(await sameSecret(secret, `${secret}x`), false);
});

test("issued session works; tampered payload, signature and extra segments fail", async () => {
  const session = await createSession(secret);
  assert.equal(await isAuthenticated(req({ Cookie: `other=x; bot_session=${session}; extra=y` }), env), true);
  const [payload, signature] = session.split(".");
  for (const invalid of [`${payload}x.${signature}`, `${payload}.${signature.slice(0, -4)}AAAA`, `${session}.extra`, "not-base64.???", ".", ""]) {
    assert.equal(await isAuthenticated(req({ Cookie: `bot_session=${invalid}` }), env), false);
  }
  assert.equal(await isAuthenticated(req({ Cookie: `bot_session=${session}` }), { ADMIN_TOKEN: `${secret}changed` } as Env), false);
});

test("signed expired and malformed expiration dates are denied", async () => {
  for (const expires of [Date.now() - 1, "9999999999999", null]) {
    const session = await signedSession(expires);
    assert.equal(await isAuthenticated(req({ Cookie: `bot_session=${session}` }), env), false);
  }
  assert.equal(await isAuthenticated(req({ Cookie: `bot_session=${await signedSession(Date.now() + 60_000)}` }), env), true);
});

test("session cookies are HttpOnly, SameSite Strict and secure on HTTPS, and clear correctly", () => {
  const cookie = sessionCookie(req(), "value");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /; Secure/); assert.match(cookie, /Max-Age=86400/);
  assert.match(sessionCookie(req(), "", true), /Max-Age=0/);
  assert.doesNotMatch(sessionCookie(new Request("http://localhost:8787"), "value"), /; Secure/);
});


test("master credentials identify owner and editor without promoting an editor", async () => {
  const editorSecret = "test-editor-secret-at-least-24-characters";
  const rolesEnv = {...env,EDITOR_TOKEN:editorSecret} as Env;
  assert.equal(await authenticatedRole(req({Authorization:`Bearer ${secret}`}),rolesEnv),"owner");
  assert.equal(await authenticatedRole(req({Authorization:`Bearer ${editorSecret}`}),rolesEnv),"editor");
  assert.equal(await isAuthenticated(req({Authorization:`Bearer ${editorSecret}`}),rolesEnv),true);
  for (const editor of [undefined,"","short"]) {
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${editorSecret}`}),{...env,EDITOR_TOKEN:editor} as Env),null);
  }
  assert.equal(await authenticatedRole(req({Authorization:`Bearer ${secret}`}),{...env,EDITOR_TOKEN:secret} as Env),"owner");
});

test("signed sessions preserve roles in Bearer headers and cookies, including legacy owner cookies", async () => {
  const rolesEnv = {...env,EDITOR_TOKEN:"test-editor-secret-at-least-24-characters"} as Env;
  for (const role of ["owner","editor"] as const) {
    const session = await createSession(secret,role);
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${session}`}),rolesEnv),role);
    assert.equal(await authenticatedRole(req({Cookie:`bot_session=${session}`}),rolesEnv),role);
    const payload = JSON.parse(Buffer.from(session.split(".")[0],"base64url").toString("utf8"));
    assert.equal(payload.role,role);
    assert.ok(payload.expires > Date.now()+86300000 && payload.expires <= Date.now()+86400000);
    assert.ok(payload.nonce);
    assert.doesNotMatch(session,/test-admin|test-editor/);
  }
  const legacyEditor = await signedSession(Date.now()+60000,"editor");
  assert.deepEqual(await authenticatedIdentity(req({Authorization:`Bearer ${legacyEditor}`}),rolesEnv),{role:"editor",subject:"editor"});
  const legacy = await signedSession(Date.now()+60000);
  assert.equal(await authenticatedRole(req({Cookie:`bot_session=${legacy}`}),rolesEnv),"owner");
  assert.equal(await authenticatedRole(req({Authorization:`Bearer ${legacy}`}),rolesEnv),"owner");
});

test("editor cannot forge an owner session by changing its role or signing with the editor credential", async () => {
  const editorSecret = "test-editor-secret-at-least-24-characters";
  const rolesEnv = {...env,EDITOR_TOKEN:editorSecret} as Env;
  const editorSession = await createSession(secret,"editor");
  const [payload,signature] = editorSession.split(".");
  const decoded = JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
  decoded.role="owner";
  const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  const forgedByEditing = `${forgedPayload}.${signature}`;
  const forgedBySigning = await createSession(editorSecret,"owner");
  for (const forged of [forgedByEditing,forgedBySigning]) {
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${forged}`}),rolesEnv),null);
    assert.equal(await authenticatedRole(req({Cookie:`bot_session=${forged}`}),rolesEnv),null);
  }
});

test("invalid roles, expired editor sessions and disabled editor access fail closed", async () => {
  const editorSecret = "test-editor-secret-at-least-24-characters";
  const rolesEnv = {...env,EDITOR_TOKEN:editorSecret} as Env;
  for (const role of ["admin","OWNER","",null,{},42]) {
    const session = await signedSession(Date.now()+60000,role);
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${session}`}),rolesEnv),null);
  }
  assert.equal(await authenticatedRole(req({Authorization:`Bearer ${await signedSession(Date.now()-1,"editor")}`}),rolesEnv),null);
  const editorSession = await createSession(secret,"editor");
  for (const disabled of [env,{...env,EDITOR_TOKEN:"short"},{...env,EDITOR_TOKEN:secret}]) {
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${editorSession}`}),disabled as Env),null);
  }
  await assert.rejects(createSession(secret,"admin" as never),/Papel de acesso inválido/);
});

test("explicit invalid authorization does not inherit the owner's ambient cookie", async () => {
  const ownerSession = await createSession(secret);
  for (const authorization of ["Bearer invalid","Bearer ",`Basic ${secret}`]) {
    assert.equal(await authenticatedRole(req({Authorization:authorization,Cookie:`bot_session=${ownerSession}`}),env),null);
  }
});


const partnerOne = "test-partner-one-secret-at-least-24-characters";
const partnerTwo = "test-partner-two-secret-at-least-24-characters";
const partnersEnv = {...env,PARTNER_1_TOKEN:partnerOne,PARTNER_2_TOKEN:partnerTwo} as Env;

test("individual partner credentials identify separate people with the same partner role", async () => {
  // Given two separate credentials for partners in the same company.
  for (const [credential,subject] of [[partnerOne,"partner-1"],[partnerTwo,"partner-2"]]) {
    // When either partner authenticates, their identity is retained independently.
    assert.deepEqual(await authenticatedIdentity(req({Authorization:`Bearer ${credential}`}),partnersEnv),{role:"partner",subject});
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${credential}`}),partnersEnv),"partner");
    const session = await createIdentitySession(partnersEnv,{role:"partner",subject});
    // Then the signed session contains neither partner credential and works with Bearer or cookie.
    assert.deepEqual(await authenticatedIdentity(req({Authorization:`Bearer ${session}`}),partnersEnv),{role:"partner",subject});
    assert.deepEqual(await authenticatedIdentity(req({Cookie:`bot_session=${session}`}),partnersEnv),{role:"partner",subject});
    const payload=JSON.parse(Buffer.from(session.split(".")[0],"base64url").toString());
    assert.ok(payload.credentialTag);assert.equal(payload.subject,subject);
    assert.ok(payload.expires > Date.now()+86300000 && payload.expires <= Date.now()+86400000);
    assert.doesNotMatch(Buffer.from(session.split(".")[0],"base64url").toString(),/test-partner|test-admin/);
  }
});

test("rotating or removing one partner credential revokes only that partner's sessions", async () => {
  // Given independently bound partner sessions.
  const first=await createIdentitySession(partnersEnv,{role:"partner",subject:"partner-1"});
  const second=await createIdentitySession(partnersEnv,{role:"partner",subject:"partner-2"});
  for (const replacement of [undefined,"short","replacement-partner-one-secret-at-least-24-characters"]) {
    const changed={...partnersEnv,PARTNER_1_TOKEN:replacement} as Env;
    // When partner one's credential changes, partner two and the owner remain unaffected.
    assert.equal(await authenticatedIdentity(req({Authorization:`Bearer ${first}`}),changed),null);
    assert.deepEqual(await authenticatedIdentity(req({Authorization:`Bearer ${second}`}),changed),{role:"partner",subject:"partner-2"});
    assert.deepEqual(await authenticatedIdentity(req({Authorization:`Bearer ${secret}`}),changed),{role:"owner",subject:"owner"});
  }
});

test("partner identity cannot be swapped, promoted or created without its credential binding", async () => {
  // Given one valid individual session, changing any signed identity claim invalidates it.
  const session=await createIdentitySession(partnersEnv,{role:"partner",subject:"partner-1"});
  const [payload,signature]=session.split(".");
  for(const change of [{subject:"partner-2"},{role:"owner",subject:"owner"},{credentialTag:"invalid"}]) {
    const changed={...JSON.parse(Buffer.from(payload,"base64url").toString()),...change};
    const forged=`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    assert.equal(await authenticatedIdentity(req({Authorization:`Bearer ${forged}`}),partnersEnv),null);
  }
  // A correctly signed payload for partner two cannot reuse partner one's credential binding.
  const swapped = {...JSON.parse(Buffer.from(payload,"base64url").toString()),subject:"partner-2"};
  const swappedPayload = Buffer.from(JSON.stringify(swapped)).toString("base64url");
  const signingKey = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const swappedSignature = await crypto.subtle.sign("HMAC",signingKey,new TextEncoder().encode(swappedPayload));
  const wronglyBound = `${swappedPayload}.${b64(new Uint8Array(swappedSignature))}`;
  assert.equal(await authenticatedIdentity(req({Authorization:`Bearer ${wronglyBound}`}),partnersEnv),null);
  // Then even a server-signed role without the individual binding fails closed.
  assert.equal(await authenticatedIdentity(req({Authorization:`Bearer ${await signedSession(Date.now()+60000,"partner")}`}),partnersEnv),null);
  await assert.rejects(createSession(secret,"partner"),/Papel de acesso inválido/);
  await assert.rejects(createIdentitySession(partnersEnv,{role:"partner",subject:"owner"}),/Identidade de acesso inválida/);
  await assert.rejects(createIdentitySession(partnersEnv,{role:"owner",subject:"partner-1"}),/Identidade de acesso inválida/);
});

test("ambiguous or reused partner keys fail closed without disabling owner access", async () => {
  // Given credentials reused across partners or privilege levels.
  for(const invalid of [
    {...partnersEnv,PARTNER_2_TOKEN:partnerOne},
    {...partnersEnv,PARTNER_1_TOKEN:secret},
    {...partnersEnv,EDITOR_TOKEN:partnerOne},
    {...partnersEnv,PARTNER_1_TOKEN:"short"},
  ]) {
    // When partner one tries its former token, it must not inherit partner or owner access.
    assert.equal(await authenticatedIdentity(req({Authorization:`Bearer ${partnerOne}`}),invalid as Env)?.role === "partner",false);
    // Then the owner's original credential continues working.
    assert.equal(await authenticatedRole(req({Authorization:`Bearer ${secret}`}),invalid as Env),"owner");
  }
});
