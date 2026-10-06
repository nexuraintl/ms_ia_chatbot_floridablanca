import { warning } from "./logging.js";

// Solo codigos conocidos; el mensaje, SQL y parametros pueden contener datos privados.
const codes = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR", "ER_PARSE_ERROR",
  "HANDSHAKE_NO_SSL_SUPPORT", "HANDSHAKE_SSL_ERROR", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"]);
export const reportConversationFailure = error => {
  warning("conversation_persistence_unavailable", { code: codes.has(error?.code) ? error.code : "DATABASE_ERROR" });
};
