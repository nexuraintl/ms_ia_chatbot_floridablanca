-- Registro de conversaciones del chatbot. MySQL 8.0+ / MariaDB 10.4+.
-- Una fila por chat.

CREATE TABLE chat (
  chat_id           VARCHAR(64)   NOT NULL,
  tenant_id         VARCHAR(64)   NOT NULL,
  citizen_name      VARCHAR(120)  NULL,
  citizen_email     VARCHAR(254)  NULL,
  consent_version   VARCHAR(40)   NULL,
  consent_at        DATETIME(3)   NULL,
  started_at        DATETIME(3)   NOT NULL,
  last_message_at   DATETIME(3)   NULL,
  ended_at          DATETIME(3)   NULL,
  -- Trámites RPA usados: ["predial","pqrsd_crear"].
  rpa_flows         JSON          NOT NULL,
  -- Mensajes: [{ id, sender, text, at }]. `id` es obligatorio
  messages          JSON          NOT NULL,
  redacted_at       DATETIME(3)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  duration_seconds  INT           GENERATED ALWAYS AS (
                                    TIMESTAMPDIFF(SECOND, started_at,
                                      COALESCE(ended_at, last_message_at, started_at))
                                  ) STORED,
  used_rpa          BOOLEAN       GENERATED ALWAYS AS (JSON_LENGTH(rpa_flows) > 0) STORED,
  message_count     INT           GENERATED ALWAYS AS (JSON_LENGTH(messages)) STORED,
  PRIMARY KEY (chat_id),
  KEY chat_tenant_idx (tenant_id, started_at),
  KEY chat_correo_idx (tenant_id, citizen_email),
  KEY chat_rpa_idx    (tenant_id, used_rpa),
  CONSTRAINT chat_id_no_vacio        CHECK (chat_id <> ''),
  CONSTRAINT chat_tenant_no_vacio    CHECK (tenant_id <> ''),
  CONSTRAINT chat_messages_arreglo   CHECK (JSON_TYPE(messages)  = 'ARRAY'),
  CONSTRAINT chat_rpa_arreglo        CHECK (JSON_TYPE(rpa_flows) = 'ARRAY'),
  CONSTRAINT chat_cierre_coherente   CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT chat_supresion_efectiva CHECK (
    redacted_at IS NULL
    OR (citizen_name IS NULL AND citizen_email IS NULL AND JSON_LENGTH(messages) = 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



