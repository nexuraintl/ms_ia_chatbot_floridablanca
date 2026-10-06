import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createConversationConfig } from "../server/conversationStore.js";
import { createConversationReadStore, parseConversationFilters } from "../server/conversationReadStore.js";
import { createConversationAdminApi } from "../server/conversationAdminApi.js";
import { serveConversationAdminPanel } from "../server/conversationAdminPanel.js";

const token = "test-only-administration-token-0123456789";
const config = createConversationConfig({ DB_HOST: "db.example", DB_NAME: "ia_chatbot_floridablanca",
  DB_USER: "test", DB_PASS: "test-only", CONVERSATION_ADMIN_TOKEN: token, ENVIRONMENT: "local" });
const row = { chat_id: "chat-1", tenant_id: "floridablanca", citizen_name: "Ana", citizen_email: "ana@example.com",
  started_at: "2026-10-06 15:00:00.000", last_message_at: "2026-10-06 15:00:10.000", ended_at: null,
  consent_at: null, consent_version: "v1", created_at: "2026-10-06 15:00:00.000", updated_at: "2026-10-06 15:00:10.000",
  rpa_flows: "[]", messages: JSON.stringify([{ id: "m1", sender: "user", text: "Hola", at: "2026-10-06T15:00:00.000Z" }]),
  duration_seconds: 10, message_count: 1, used_rpa: 0, redacted_at: null };

test("filtros estrictos: fechas reales, limites, duplicados y cursor validado", () => {
  const filters = parseConversationFilters(new URLSearchParams("from=2026-10-01&to=2026-10-06&usedRpa=false&email=ana%40example.com&limit=25"));
  assert.equal(filters.from, "2026-10-01 00:00:00.000");
  assert.equal(filters.to, "2026-10-07 00:00:00.000");
  assert.equal(filters.usedRpa, false);
  assert.equal(filters.limit, 25);
  for (const query of ["from=2026-02-30", "from=2026-10-07&to=2026-10-06", "limit=101", "limit=0", "limit=1%20OR%201=1",
    "usedRpa=yes", "limit=20&limit=30", "tenant_id=otro", "cursor=invalid", "email=", "password=x"]) {
    assert.throws(() => parseConversationFilters(new URLSearchParams(query)), error => error.status === 400);
  }
});

test("consulta paginada: tenant fijo, resumen sin mensajes, cursor estable sin OFFSET", async () => {
  const calls = [];
  const rows = [row, { ...row, chat_id: "chat-0" }];
  const pool = { async execute({ sql }, values) { calls.push({ sql, values }); return [rows]; } };
  const store = createConversationReadStore({ config, pool });
  const first = await store.listConversations({ limit: 1, email: "' OR 1=1 --" });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].started_at, "2026-10-06T15:00:00.000Z");
  assert.equal(Object.hasOwn(first.items[0], "messages"), false);
  assert.ok(!calls[0].sql.includes("THEN messages"));
  assert.ok(!calls[0].sql.includes("SELECT *"));
  assert.ok(!calls[0].sql.includes("' OR 1=1 --"));
  assert.deepEqual(calls[0].values, ["floridablanca", "' OR 1=1 --"]);
  const filters = parseConversationFilters(new URLSearchParams({ cursor: first.nextCursor, limit: "1" }));
  await store.listConversations(filters);
  assert.ok(calls[1].sql.includes("started_at < ?"));
  assert.ok(!calls[1].sql.includes("OFFSET"));
  assert.equal(calls[1].values[0], "floridablanca");
  assert.equal(calls[1].values.at(-1), "chat-1");
});

test("detalle y descarga respetan tenant y supresion; limite de exportacion no trunca", async () => {
  let rows = [{ ...row, redacted_at: "2026-10-06 16:00:00.000" }];
  const calls = [];
  const pool = { async execute({ sql }, values) { calls.push({ sql, values }); return [rows]; } };
  const store = createConversationReadStore({ config, pool });
  const detail = await store.getConversation("chat-1");
  assert.deepEqual(detail.messages, []);
  assert.deepEqual(detail.rpa_flows, []);
  assert.equal(detail.citizen_name, null);
  assert.equal(detail.citizen_email, null);
  assert.equal(detail.message_count, 0);
  assert.deepEqual(calls[0].values, ["floridablanca", "chat-1"]);
  rows = [];
  await assert.rejects(store.getConversation("other-tenant-chat"), error => error.status === 404);
  rows = Array(10001).fill(row);
  await assert.rejects(store.exportConversationSummaries({}), error => error.status === 413);
});

const fixture = async work => {
  let api;
  const store = { async listConversations(filters) { return { items: [{ ...row, messages: undefined }], nextCursor: null, filters }; },
    async getConversation(id) { if (id !== "chat-1") throw Object.assign(new Error("missing"), { status: 404 }); return row; },
    async exportConversationSummaries() { return [{ ...row, citizen_name: '=HYPERLINK("https://evil.example")', citizen_email: "+cmd", rpa_flows: [] }]; } };
  const server = http.createServer((req, res) => req.url.startsWith("/admin/") ? serveConversationAdminPanel(req, res) : api.handle(req, res));
  api = createConversationAdminApi({ config, store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path = "", opts = {}) => fetch(origin + "/api/v1/admin/conversations" + path,
    { ...opts, headers: { Authorization: "Bearer " + token, ...opts.headers } });
  try { await work({ origin, get, store, setConfig(value) { api = createConversationAdminApi({ config: value, store }); } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
};

test("API privada: sin clave, clave incorrecta y token en URL nunca consultan la BD", () => fixture(async ({ get, store, setConfig }) => {
  let calls = 0; store.listConversations = async () => { calls++; return { items: [], nextCursor: null }; };
  assert.equal((await get("", { headers: { Authorization: "" } })).status, 401);
  assert.equal((await get("", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await get("?token=" + token, { headers: { Authorization: "" } })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await get()).status, 200);
  assert.equal(calls, 1);
  for (const adminToken of ["", "short"]) {
    setConfig({ ...config, adminToken });
    assert.equal((await get()).status, 503);
  }
  assert.equal(calls, 1);
}));

test("API privada: CSV para Excel, JSON completo, CORS bloqueado y errores sin secretos", () => fixture(async ({ get, store }) => {
  const list = await get("?limit=10");
  assert.equal(list.headers.get("Cache-Control"), "no-store");
  assert.equal(list.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await get("", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await get("", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await get("", { method: "POST" })).status, 405);
  assert.equal((await get("/chat-1?unexpected=true")).status, 400);
  assert.equal((await get("?limit=1000")).status, 400);
  const csv = await get("/export.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("Content-Disposition"), /attachment/);
  assert.equal(csv.headers.get("X-Exported-Count"), "1");
  const text = await csv.text();
  assert.match(text, /"'=HYPERLINK\(""https:\/\/evil.example""\)"/);
  assert.match(text, /"'\+cmd"/);
  assert.ok(!text.includes("Hola"));
  const json = await get("/chat-1/export.json");
  assert.match(json.headers.get("Content-Disposition"), /floria-chat-chat-1.json/);
  assert.equal((await json.json()).chat_id, "chat-1");
  store.listConversations = async () => { throw new Error("SQL password=private citizen=Ana"); };
  const failed = await get();
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { reason: "persistence_unavailable" });
}));

test("panel con CSP y prefijos relativos; assets desconocidos nunca exponen archivos", () => fixture(async ({ origin }) => {
  const redirect = await fetch(origin + "/admin/chats", { redirect: "manual" });
  assert.equal(redirect.headers.get("Location"), "chats/");
  const page = await fetch(origin + "/admin/chats/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  assert.match(await page.text(), /Clave de administración/);
  assert.equal((await fetch(origin + "/admin/chats/app.js")).status, 200);
  assert.equal((await fetch(origin + "/admin/chats/unknown")).status, 404);
}));

test("los intentos de acceso al panel tambien tienen limite por IP", () => fixture(async ({ get }) => {
  for (let i = 0; i < 30; i++) assert.equal((await get("", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const response = await get();
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
}));
