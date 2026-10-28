import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvValues } from "../scripts/env-values.mjs";

test("reconfiguring provider keys preserves both individual partner credentials and existing access",()=>{
  // Given a file containing the owner, optional editor and two numbered partner credentials.
  const original=["# local configuration","ADMIN_TOKEN=owner-credential","EDITOR_TOKEN=editor-credential","PARTNER_1_TOKEN=first-partner-credential","PARTNER_2_TOKEN=second-partner-credential",'GEMINI_API_KEY="provider-old"',""].join("\n");
  const values=parseEnvValues(original);
  // When the local configure command changes a provider and writes its normal JSON-quoted format.
  values.GEMINI_API_KEY="provider-new";
  const saved=Object.entries(values).map(([name,value])=>`${name}=${JSON.stringify(value)}`).join("\n");
  const restored=parseEnvValues(saved);
  // Then access credentials are unchanged instead of silently dropping the numbered keys.
  assert.equal(restored.PARTNER_1_TOKEN,"first-partner-credential");
  assert.equal(restored.PARTNER_2_TOKEN,"second-partner-credential");
  assert.equal(restored.ADMIN_TOKEN,"owner-credential");assert.equal(restored.EDITOR_TOKEN,"editor-credential");
  assert.equal(restored.GEMINI_API_KEY,"provider-new");
});

test("local configuration round-trips quoted values, empty entries and Windows newlines",()=>{
  const parsed=parseEnvValues("PARTNER_1_TOKEN='first-with=separator'\r\nPARTNER_2_TOKEN=second\r\nEDITOR_TOKEN=\r\n# ignored\r\n");
  assert.deepEqual(parsed,{PARTNER_1_TOKEN:"first-with=separator",PARTNER_2_TOKEN:"second",EDITOR_TOKEN:""});
});
