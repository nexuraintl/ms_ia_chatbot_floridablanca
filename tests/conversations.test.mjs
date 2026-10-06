import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setImmediate as tick } from "node:timers/promises";
import { IDBFactory } from "fake-indexeddb";
import { createConversationConfig, createConversationStore } from "../server/conversationStore.js";
import { createConversationApi } from "../server/conversationApi.js";
import { createOutboxStore } from "../src/adapters/persistence/outboxStore.js";
import { createOutboxConversationRepository } from "../src/adapters/persistence/OutboxConversationRepository.js";
import { createConversationWriter } from "../src/adapters/persistence/ConversationWriter.js";
import { createConversationSession } from "../src/adapters/browser/conversationSession.js";

const config = createConversationConfig({ ENVIRONMENT: "local", DB_HOST: "db.example", DB_USER: "test",
  DB_PASS: "test-only", DB_NAME: "ia_chatbot_floridablanca" });
const envelope = { schemaVersion: 1, tenantId: "floridablanca", conversationId: "chat-1" };
const message = { ...envelope, messageId: "m-1", sender: "user", text: "Hola", sequence: 0 };

test("configuración del servidor limita conexiones y exige TLS; no se conecta sin credenciales", () => {
  assert.equal(createConversationConfig({}).enabled, false);
  assert.equal(config.poolOptions.connectionLimit, 5);
  assert.equal(config.poolOptions.ssl.rejectUnauthorized, true);
  assert.equal(config.table, "chat");
  assert.throws(() => createConversationConfig({ DB_TABLE: "chat; DROP TABLE chat" }));
  assert.throws(() => createConversationConfig({ DB_CONNECTION_LIMIT: "1000" }));
});

const stubPool = row => {
  const calls = [];
  let failCommit = false;
  const connection = {
    async beginTransaction() { calls.push({ kind: "begin" }); },
    async execute({ sql }, values) {
      calls.push({ kind: "query", sql, values });
      return [sql.startsWith("SELECT") ? (row ? [row] : []) : { affectedRows: 1 }];
    },
    async commit() { calls.push({ kind: "commit" }); if (failCommit) throw new Error("commit failed"); },
    async rollback() { calls.push({ kind: "rollback" }); },
    release() { calls.push({ kind: "release" }); }
  };
  return { calls, setFailCommit() { failCommit = true; },
    pool: { async getConnection() { return connection; }, async end() {} } };
};

test("la fila JSON deduplica por ID, agrega una tanda y usa el reloj del servidor", async () => {
  const existing = { id: "m-1", sender: "user", text: "Primero", at: "2026-10-02T10:00:00Z" };
  const stub = stubPool({ tenant_id: "floridablanca", messages: JSON.stringify([existing]), rpa_flows: "[]" });
  const store = createConversationStore({ config, pool: stub.pool, now: () => new Date("2026-10-02T11:00:00Z") });
  const result = await store.appendMessages("chat-1", [message,
    { ...message, messageId: "m-2", text: "Formulario", metadata: { component: "predial_form" } },
    { ...message, messageId: "m-2", text: "Duplicado" }]);
  assert.equal(result.added, 1);
  const updates = stub.calls.filter(call => call.sql?.startsWith("UPDATE"));
  assert.equal(updates.length, 1);
  const saved = JSON.parse(updates[0].values[0]);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], existing);
  assert.equal(saved[1].at, "2026-10-02T11:00:00.000Z");
  assert.deepEqual(JSON.parse(updates[0].values[1]), ["predial"]);
  assert.deepEqual(stub.calls.slice(-2).map(call => call.kind), ["commit", "release"]);
});

test("una actualización no restaura conversaciones suprimidas ni mezcla tenants", async () => {
  const stub = stubPool({ tenant_id: "floridablanca", redacted_at: "2026-10-01", messages: "[]", rpa_flows: "[]" });
  const store = createConversationStore({ config, pool: stub.pool });
  assert.deepEqual(await store.appendMessages("chat-1", [message]), { redacted: true });
  assert.equal(stub.calls.some(call => call.sql?.startsWith("UPDATE")), false);
  const other = stubPool({ tenant_id: "otro" });
  await assert.rejects(createConversationStore({ config, pool: other.pool }).openConversation(envelope),
    error => error.status === 409);
  assert.deepEqual(other.calls.slice(-2).map(call => call.kind), ["rollback", "release"]);
});

test("un commit fallido nunca se confirma y siempre libera la conexión", async () => {
  const stub = stubPool({ tenant_id: "floridablanca", messages: [], rpa_flows: [] });
  stub.setFailCommit();
  await assert.rejects(createConversationStore({ config, pool: stub.pool }).appendMessages("chat-1", [message]));
  assert.deepEqual(stub.calls.slice(-3).map(call => call.kind), ["commit", "rollback", "release"]);
});

test("API HTTP: cabecera, mensajes, cierre, validación, CORS y error sin detalles", async () => {
  const called = [];
  const store = {
    async openConversation(data) { called.push(["open", data]); return { saved: true }; },
    async appendMessages(id, records) { called.push(["messages", id, records]); return { saved: true }; },
    async closeConversation(id) { called.push(["close", id]); return { saved: true }; }
  };
  const api = createConversationApi({ config, store });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/conversations`;
  const send = (path, body, headers = {}) => fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await send("", envelope)).status, 200);
    assert.equal((await send("/chat-1/messages", { messages: [message] })).status, 200);
    assert.equal((await send("/chat-1/close", envelope)).status, 200);
    assert.deepEqual(called.map(call => call[0]), ["open", "messages", "close"]);
    assert.equal((await send("", { ...envelope, tenantId: "otro" })).status, 400);
    assert.equal((await send("/chat-1/messages", { messages: [{ ...message, conversationId: "otro" }] })).status, 400);
    assert.equal((await send("/chat-1/messages", { messages: [{ ...message, messageId: undefined }] })).status, 400);
    assert.equal((await send("", envelope, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(base, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } })).status, 204);
    assert.equal((await fetch(base)).status, 405);
    assert.equal((await send("/not-supported", envelope)).status, 404);
    store.openConversation = async () => { throw new Error("private password and citizen data"); };
    const failed = await send("", envelope);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { reason: "persistence_unavailable" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("la sesión conserva secuencia e inicio tras recargar, y separa tenants", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = createConversationSession({ tenantId: "floridablanca", storage, makeId: () => "session-1" });
  assert.equal(first.reserveSequence(), 0);
  const reloaded = createConversationSession({ tenantId: "floridablanca", storage });
  assert.equal(reloaded.id, first.id);
  assert.equal(reloaded.startedAt, first.startedAt);
  assert.equal(reloaded.reserveSequence(), 1);
  assert.equal(createConversationSession({ tenantId: "otro", storage, makeId: () => "session-2" }).reserveSequence(), 0);
  assert.notEqual(createConversationSession({ tenantId: "floridablanca", storage, fresh: true }).id, first.id);
});

test("API acota peticiones por IP y falla explícitamente si falta configuración", async () => {
  const limited = createConversationApi({ config: { ...config, ratePerMinute: 1 },
    store: { async openConversation() { return { saved: true }; } } });
  const disabled = createConversationApi({ config: { ...config, enabled: false }, store: {} });
  let api = limited;
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/conversations`;
  const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope) });
  try {
    assert.equal((await send()).status, 200);
    const response = await send();
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    api = disabled;
    const unavailable = await send();
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { reason: "persistence_not_configured" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("un fallo al encolar se reintenta con el mismo mensaje, secuencia y cabecera", async () => {
  const attempts = [];
  const order = [];
  let fail = true;
  const repository = { async openConversation() { order.push("header"); },
    async appendMessages(records) { attempts.push(structuredClone(records)); if (fail) throw new Error("quota"); order.push("messages"); },
    async closeConversation() { order.push("close"); }, async flush() { return { pending: 0 }; } };
  const writer = createConversationWriter({ repository, tenantId: "floridablanca" });
  const session = createConversationSession({ tenantId: "floridablanca", storage: null });
  const input = { session, messages: [{ id: "ui-1", sender: "user", text: "Hola" }] };
  try {
    await assert.rejects(writer.record(input));
    fail = false;
    await writer.record(input);
    await writer.record(input);
    await writer.close(session);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(attempts.length, 2);
    assert.deepEqual(order, ["header", "messages", "close"]);
  } finally { writer.dispose(); }
});

test("IndexedDB aborta una tanda completa ante duplicado y no confirma antes del commit", async () => {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  const store = await createOutboxStore();
  await assert.rejects(store.putMany([{ key: 1 }, { key: 1 }]));
  assert.equal(await store.count(), 0);
  const realOpen = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = realOpen(...args);
    request.addEventListener("success", () => {
      const database = request.result;
      const realTransaction = database.transaction.bind(database);
      database.transaction = (...txArgs) => {
        const transaction = realTransaction(...txArgs);
        const realObjectStore = transaction.objectStore.bind(transaction);
        transaction.objectStore = name => {
          const objectStore = realObjectStore(name);
          const realAdd = objectStore.add.bind(objectStore);
          objectStore.add = value => {
            const add = realAdd(value);
            add.addEventListener("success", () => transaction.abort());
            return add;
          };
          return objectStore;
        };
        return transaction;
      };
    });
    return request;
  };
  const aborting = await createOutboxStore();
  await assert.rejects(aborting.put({ kind: "message", payload: message }));
  assert.equal(await store.count(), 0);
});

test("la cola recupera visitas previas y entrega cabecera antes de mensajes y cierre", async () => {
  globalThis.indexedDB = new IDBFactory();
  const seed = await createOutboxStore();
  await seed.putMany([{ kind: "envelope", payload: envelope }, { kind: "message", payload: message }]);
  const delivered = [];
  const delegate = { name: "test", async openConversation() { delivered.push("header"); },
    async appendMessages() { delivered.push("messages"); }, async closeConversation() { delivered.push("close"); },
    async flush() { return { pending: 0 }; } };
  const repository = createOutboxConversationRepository({ delegate });
  for (let i = 0; i < 100 && await seed.count(); i++) await tick();
  assert.deepEqual(delivered, ["header", "messages"]);
  await repository.closeConversation(envelope);
  for (let i = 0; i < 100 && await seed.count(); i++) await tick();
  assert.deepEqual(delivered, ["header", "messages", "close"]);
  assert.equal(await seed.count(), 0);
});
