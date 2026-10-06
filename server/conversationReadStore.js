import { ConversationError } from "./conversationStore.js";

const invalid = () => { throw new ConversationError(400, "invalid_filters"); };
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const dateValue = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.toISOString().slice(0, 10) !== value) return invalid();
  return date;
};
const sqlTime = date => date.toISOString().slice(0, 23).replace("T", " ");
const iso = value => value == null ? null : value instanceof Date ? value.toISOString()
  : new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z")).toISOString();
const parseArray = value => {
  const array = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(array)) throw new Error("Invalid stored conversation");
  return array;
};

export const parseConversationFilters = params => {
  const allowed = new Set(["from", "to", "email", "usedRpa", "limit", "cursor"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) invalid();
  const filters = { limit: 50 };
  if (params.has("from")) filters.from = sqlTime(dateValue(params.get("from")));
  if (params.has("to")) {
    const date = dateValue(params.get("to"));
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCFullYear() > 9999) invalid();
    filters.to = sqlTime(date);
  }
  if (filters.from && filters.to && filters.from >= filters.to) invalid();
  if (params.has("email")) {
    const email = params.get("email").trim();
    if (!email || email.length > 254) invalid();
    filters.email = email;
  }
  if (params.has("usedRpa")) {
    const flag = params.get("usedRpa");
    if (!["true", "false"].includes(flag)) invalid();
    filters.usedRpa = flag === "true";
  }
  if (params.has("limit")) {
    if (!/^\d{1,3}$/.test(params.get("limit"))) invalid();
    filters.limit = Number(params.get("limit"));
    if (filters.limit < 1 || filters.limit > 100) invalid();
  }
  if (params.has("cursor")) {
    const cursor = params.get("cursor");
    if (!/^[\w-]{1,240}$/.test(cursor)) invalid();
    try {
      const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
          new Date(at).toISOString() !== at || typeof id !== "string" || !ID.test(id)) invalid();
      filters.cursor = { at: sqlTime(new Date(at)), id };
    } catch { invalid(); }
  }
  return filters;
};

const summaryColumns = `chat_id, tenant_id,
  CASE WHEN redacted_at IS NULL THEN citizen_name ELSE NULL END AS citizen_name,
  CASE WHEN redacted_at IS NULL THEN citizen_email ELSE NULL END AS citizen_email,
  consent_version, consent_at, started_at, last_message_at, ended_at,
  CASE WHEN redacted_at IS NULL THEN rpa_flows ELSE '[]' END AS rpa_flows,
  duration_seconds, used_rpa, message_count, redacted_at, created_at, updated_at`;
const normalize = (row, includeMessages = false) => {
  const data = { ...row, rpa_flows: row.redacted_at ? [] : parseArray(row.rpa_flows),
    used_rpa: !row.redacted_at && Boolean(Number(row.used_rpa)),
    message_count: row.redacted_at ? 0 : Number(row.message_count), duration_seconds: Number(row.duration_seconds) };
  for (const key of ["consent_at", "started_at", "last_message_at", "ended_at", "redacted_at", "created_at", "updated_at"]) {
    data[key] = iso(row[key]);
  }
  if (row.redacted_at) data.citizen_name = data.citizen_email = null;
  if (includeMessages) data.messages = row.redacted_at ? [] : parseArray(row.messages);
  else delete data.messages;
  return data;
};

export const createConversationReadStore = ({ config, pool }) => {
  const table = `\`${config.table}\``;
  const read = async (sql, values) => {
    if (!pool) throw new ConversationError(503, "persistence_not_configured");
    const [rows] = await pool.execute({ sql, timeout: 10_000 }, values);
    return rows;
  };
  const selection = filters => {
    const clauses = ["tenant_id = ?"];
    const values = [config.tenantId];
    if (filters.from) { clauses.push("started_at >= ?"); values.push(filters.from); }
    if (filters.to) { clauses.push("started_at < ?"); values.push(filters.to); }
    if (filters.email) { clauses.push("citizen_email = ? AND redacted_at IS NULL"); values.push(filters.email); }
    if (filters.usedRpa !== undefined) { clauses.push("used_rpa = ? AND redacted_at IS NULL"); values.push(filters.usedRpa ? 1 : 0); }
    if (filters.cursor) {
      clauses.push("(started_at < ? OR (started_at = ? AND chat_id < ?))");
      values.push(filters.cursor.at, filters.cursor.at, filters.cursor.id);
    }
    return { where: clauses.join(" AND "), values };
  };
  return {
    async listConversations(filters) {
      if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) invalid();
      const { where, values } = selection(filters);
      // El limite se valida antes; se incluye literal para evitar incompatibilidades de
      // parametros LIMIT entre versiones de MySQL/MariaDB. No se carga el JSON de mensajes.
      const rows = await read(`SELECT ${summaryColumns} FROM ${table} WHERE ${where}
        ORDER BY started_at DESC, chat_id DESC LIMIT ${filters.limit + 1}`, values);
      const items = rows.slice(0, filters.limit).map(row => normalize(row));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > filters.limit
        ? Buffer.from(JSON.stringify([last.started_at, last.chat_id])).toString("base64url") : null };
    },
    async getConversation(id) {
      const rows = await read(`SELECT ${summaryColumns},
        CASE WHEN redacted_at IS NULL THEN messages ELSE '[]' END AS messages
        FROM ${table} WHERE tenant_id = ? AND chat_id = ? LIMIT 1`, [config.tenantId, id]);
      if (!rows[0]) throw new ConversationError(404, "conversation_not_found");
      return normalize(rows[0], true);
    },
    async exportConversationSummaries(filters) {
      const { where, values } = selection({ ...filters, cursor: undefined });
      const rows = await read(`SELECT ${summaryColumns} FROM ${table} WHERE ${where}
        ORDER BY started_at DESC, chat_id DESC LIMIT 10001`, values);
      if (rows.length > 10000) throw new ConversationError(413, "export_too_large");
      return rows.map(row => normalize(row));
    }
  };
};
