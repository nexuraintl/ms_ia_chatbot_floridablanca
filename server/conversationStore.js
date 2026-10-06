import fs from "node:fs";
import mysql from "mysql2/promise";

export class ConversationError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const integer = (value, fallback, max) => {
  const result = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) {
    throw new Error("Invalid database numeric configuration");
  }
  return result;
};

export const createConversationConfig = (env = process.env) => {
  const table = env.DB_TABLE || "chat";
  const tenantId = env.DB_TENANT_ID || "floridablanca";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table) || !/^[\w-]{1,64}$/.test(tenantId)) {
    throw new Error("Invalid database table or tenant configuration");
  }
  const sslMode = env.DB_SSL_MODE || "required";
  if (!["required", "disabled"].includes(sslMode)) throw new Error("Invalid DB_SSL_MODE");
  return {
    enabled: Boolean((env.DB_HOST || env.DB_SOCKET_PATH) && env.DB_USER && env.DB_NAME && env.DB_PASS),
    table,
    tenantId,
    ratePerMinute: integer(env.CONVERSATION_RATE_LIMIT_PER_MINUTE, 120, 1000),
    trustedProxyHops: integer(env.TRUSTED_PROXY_HOPS, 2, 10),
    allowedOrigins: String(env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
    isLocal: (env.ENVIRONMENT || "local") === "local",
    poolOptions: {
      host: env.DB_HOST,
      socketPath: env.DB_SOCKET_PATH || undefined,
      port: integer(env.DB_PORT, 3306, 65535),
      user: env.DB_USER,
      password: env.DB_PASS,
      database: env.DB_NAME,
      connectionLimit: integer(env.DB_CONNECTION_LIMIT, 5, 20),
      maxIdle: 2,
      idleTimeout: 60_000,
      queueLimit: 50,
      waitForConnections: true,
      connectTimeout: 5_000,
      enableKeepAlive: true,
      charset: "utf8mb4",
      timezone: "Z",
      dateStrings: true,
      ssl: sslMode === "required" ? {
        rejectUnauthorized: true,
        ...(env.DB_SSL_CA_FILE ? { ca: fs.readFileSync(env.DB_SSL_CA_FILE) } : {})
      } : undefined
    }
  };
};

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const isId = value => typeof value === "string" && ID.test(value);
const bad = () => { throw new ConversationError(400, "invalid_payload"); };
const checkIdentity = (identity) => {
  if (identity == null) return;
  if (typeof identity !== "object" || typeof identity.name !== "string" || identity.name.length > 120 ||
      typeof identity.email !== "string" || identity.email.length > 254) bad();
};

export const validateConversationPayload = (payload, { tenantId, conversationId, kind }) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) bad();
  if (kind === "messages") {
    if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 50) bad();
    for (const message of payload.messages) {
      if (!message || message.schemaVersion !== 1 || message.tenantId !== tenantId ||
          message.conversationId !== conversationId || !isId(message.messageId) ||
          !["user", "bot", "system"].includes(message.sender) || typeof message.text !== "string" ||
          message.text.length > 8000) bad();
    }
    return payload;
  }
  if (payload.tenantId !== tenantId || !isId(payload.conversationId) ||
      (conversationId && payload.conversationId !== conversationId)) bad();
  if (kind === "envelope") {
    if (payload.schemaVersion !== 1) bad();
    checkIdentity(payload.identity);
    if (payload.consent != null && (typeof payload.consent.noticeVersion !== "string" ||
        payload.consent.noticeVersion.length > 40 || !payload.consent.noticeVersion)) bad();
  }
  return payload;
};

const asArray = value => {
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(result)) throw new Error("Invalid chat JSON data");
  return result;
};

const FLOW_BY_COMPONENT = {
  predial_form: "predial", predial_multiples: "predial",
  pqrsd_crear: "pqrsd_crear", pqrsd_consult: "pqrsd_consultar"
};

/** Una fila por chat. El bloqueo de fila evita perder mensajes concurrentes. */
export const createConversationStore = ({ config, pool = config.enabled ? mysql.createPool(config.poolOptions) : null,
  now = () => new Date() }) => {
  const table = `\`${config.table}\``;
  const query = (connection, sql, values) => connection.execute({ sql, timeout: 10_000 }, values);
  const transaction = async (chatId, work, { create = false } = {}) => {
    if (!pool) throw new ConversationError(503, "persistence_not_configured");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (create) {
        await query(connection, `INSERT INTO ${table} (chat_id, tenant_id, started_at, rpa_flows, messages)
          VALUES (?, ?, ?, '[]', '[]') ON DUPLICATE KEY UPDATE chat_id = chat_id`,
        [chatId, config.tenantId, now()]);
      }
      const [rows] = await query(connection, `SELECT tenant_id, messages, rpa_flows, redacted_at
        FROM ${table} WHERE chat_id = ? FOR UPDATE`, [chatId]);
      const row = rows[0];
      if (!row) throw new ConversationError(409, "conversation_not_open");
      if (row.tenant_id !== config.tenantId) throw new ConversationError(409, "conversation_conflict");
      // Una entrega atrasada no puede restaurar datos de una conversación suprimida.
      const result = row.redacted_at ? { redacted: true } : await work(connection, row);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  };

  return {
    async openConversation(envelope) {
      return transaction(envelope.conversationId, async connection => {
        // El tiempo inicial es del servidor y no se cambia al actualizar identidad.
        await query(connection, `UPDATE ${table} SET citizen_name = COALESCE(?, citizen_name),
          citizen_email = COALESCE(?, citizen_email),
          consent_at = CASE WHEN ? IS NOT NULL AND consent_version IS NULL THEN ? ELSE consent_at END,
          consent_version = COALESCE(?, consent_version) WHERE chat_id = ?`, [
          envelope.identity?.name ?? null, envelope.identity?.email ?? null,
          envelope.consent?.noticeVersion ?? null, now(), envelope.consent?.noticeVersion ?? null,
          envelope.conversationId
        ]);
        return { saved: true };
      }, { create: true });
    },
    async appendMessages(chatId, records) {
      return transaction(chatId, async (connection, row) => {
        const messages = asArray(row.messages);
        const ids = new Set(messages.map(message => message.id));
        const flows = new Set(asArray(row.rpa_flows));
        const receivedAt = now();
        let added = 0;
        for (const record of records) {
          if (ids.has(record.messageId)) continue;
          ids.add(record.messageId);
          messages.push({ id: record.messageId, sender: record.sender, text: record.text, at: receivedAt.toISOString() });
          const component = record.metadata?.component;
          const flow = typeof component === "string" && Object.hasOwn(FLOW_BY_COMPONENT, component)
            ? FLOW_BY_COMPONENT[component] : null;
          if (flow) flows.add(flow);
          added++;
        }
        const serialized = JSON.stringify(messages);
        if (messages.length > 2000 || Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
          throw new ConversationError(413, "conversation_too_large");
        }
        if (added) await query(connection, `UPDATE ${table} SET messages = ?, rpa_flows = ?,
          last_message_at = ?, ended_at = NULL WHERE chat_id = ?`,
        [serialized, JSON.stringify([...flows]), receivedAt, chatId]);
        return { saved: true, added };
      });
    },
    async closeConversation(chatId) {
      return transaction(chatId, async connection => {
        await query(connection, `UPDATE ${table} SET ended_at = COALESCE(ended_at, ?) WHERE chat_id = ?`, [now(), chatId]);
        return { saved: true };
      });
    },
    async close() { if (pool) await pool.end(); }
  };
};
