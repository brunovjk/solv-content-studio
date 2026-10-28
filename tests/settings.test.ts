import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings, localClock, safePublicUrl, validateSettings } from "../src/settings.ts";
import { configuredSettings } from "./helpers.ts";

test("Solv defaults start paused for approval with no channels connected", () => {
  const settings = validateSettings(structuredClone(defaultSettings));
  assert.equal(settings.mode, "approval");
  assert.equal(settings.paused, true);
  assert.equal(settings.brandName, "Solv");
  assert.equal(settings.brandHandle, "@solv_tec");
  assert.deepEqual(settings.channels, []);
});

test("accepts a public HTTPS URL and blocks credentials, local hosts, IP addresses and SSRF aliases", () => {
  assert.equal(safePublicUrl("https://clinic-content-bot.workers.dev"), true);
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254", "https://[::1]", "https://intranet.local", "https://metadata.internal", "https://app.test", "https://app.invalid", "https://localhost.localdomain", "https://private.127.0.0.1.nip.io", "https://private.127.0.0.1.sslip.io", "https://foo.localtest.me", "https://example.com:8080", "not-a-url"]) {
    assert.equal(safePublicUrl(url), false, url);
  }
});

test("rejects invalid source URLs, Portuguese/Brazilian sources and duplicate identifiers", () => {
  for (const value of ["https://127.0.0.1/feed", "http://news.example.com/feed", "https://user:secret@news.example.com/feed"]) {
    const settings = configuredSettings(); settings.sources[0].url = value;
    assert.throws(() => validateSettings(settings), /HTTPS públicas/);
  }
  const portuguese = configuredSettings(); portuguese.sources[0].language = "pt-BR";
  assert.throws(() => validateSettings(portuguese), /estrangeiras/);
  const brazil = configuredSettings(); brazil.sources[0].website = "https://news.com.br";
  assert.throws(() => validateSettings(brazil), /estrangeiras/);
  const duplicates = configuredSettings(); duplicates.sources.push({ ...duplicates.sources[0] });
  assert.throws(() => validateSettings(duplicates), /identificadores repetidos/);
});

test("enforces bounded schedules, quota, topics, branding and timezone", () => {
  const cases: Record<string, unknown>[] = [
    { mode: "anything" }, { paused: "false" }, { brandColor: "red" }, { hour: 24 }, { daysOfWeek: [7] },
    { maxPostsPerDay: 4 }, { maxCandidates: 0 }, { minRelevance: 49 }, { maxAgeDays: 91 }, { topics: [] },
    { brandName: " " }, { timezone: undefined }, { timezone: "Not/A_Timezone" },
  ];
  for (const update of cases) assert.throws(() => validateSettings({ ...configuredSettings(), ...update }), JSON.stringify(update));
});

test("normalizes duplicate days and removes unknown fields such as accidental secrets", () => {
  const value = validateSettings({ ...configuredSettings(), daysOfWeek: [1, 1, 3], brandName: "  Meu Estúdio  ", GEMINI_API_KEY: "must not persist" });
  assert.deepEqual(value.daysOfWeek, [1, 3]);
  assert.equal(value.brandName, "Meu Estúdio");
  assert.equal("GEMINI_API_KEY" in value, false);
});

test("rejects duplicate channels and too many channels", () => {
  const value = configuredSettings(); value.channels.push({ ...value.channels[0] });
  assert.throws(() => validateSettings(value), /Canais repetidos/);
  value.channels = ["a", "b", "c", "d"].map(id => ({ id, name: id, service: "instagram", enabled: true }));
  assert.throws(() => validateSettings(value), /até 3 canais/);
});

test("clock uses São Paulo day and date instead of UTC at midnight", () => {
  assert.deepEqual(localClock(new Date("2026-10-22T01:30:00Z"), "America/Sao_Paulo"), { date: "2026-10-21", hour: 22, day: 3 });
  assert.deepEqual(localClock(new Date("2026-10-22T12:00:00Z"), "America/Sao_Paulo"), { date: "2026-10-22", hour: 9, day: 4 });
});


test("accepts older settings without optional business context and preserves new client context", () => {
  const legacy = configuredSettings();
  delete legacy.websiteUrl;
  delete legacy.offerSummary;
  delete legacy.editorialGuidelines;
  delete legacy.visualGuidelines;
  const older = validateSettings(legacy);
  assert.equal(older.websiteUrl, "");
  assert.equal(older.offerSummary, "");
  const current = validateSettings({ ...legacy, websiteUrl: " https://solv-cf55a.web.app/ ", offerSummary: " Uma página com até 7 seções. ", editorialGuidelines: "Sem promessas de resultado.", visualGuidelines: "Azul e grafite." });
  assert.equal(current.websiteUrl, "https://solv-cf55a.web.app/");
  assert.equal(current.offerSummary, "Uma página com até 7 seções.");
  assert.equal(current.editorialGuidelines, "Sem promessas de resultado.");
  assert.equal(current.visualGuidelines, "Azul e grafite.");
});

test("rejects unsafe brand websites and malformed or oversized business context", () => {
  for (const websiteUrl of ["http://solv-cf55a.web.app/", "https://user:secret@solv-cf55a.web.app/", "https://localhost", "https://127.0.0.1", "not a website"]) {
    assert.throws(() => validateSettings({ ...configuredSettings(), websiteUrl }), /Site da marca/);
  }
  for (const [field, limit] of [["offerSummary", 3500], ["editorialGuidelines", 2500], ["visualGuidelines", 1000]] as const) {
    assert.throws(() => validateSettings({ ...configuredSettings(), [field]: "x".repeat(limit + 1) }));
    assert.throws(() => validateSettings({ ...configuredSettings(), [field]: 42 }));
    assert.throws(() => validateSettings({ ...configuredSettings(), [field]: "texto\u0000oculto" }));
  }
});
