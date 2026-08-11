import { ShieldAlert } from "lucide-react";
import { forModelOutput } from "../../domain/security/urlPolicy";

/**
 * Renderizado de texto con formato ligero (negrillas, viñetas y enlaces).
 *
 * Extraído de `ChatBubble.jsx`, que mezclaba el analizador de Markdown con la
 * presentación de la burbuja.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ÚLTIMA LÍNEA DE DEFENSA CONTRA INYECCIÓN DE PROMPT
 *
 * Aquí es donde se corta la cadena de ataque. Aunque alguien logre inyectar
 * instrucciones en el modelo a través del DOM de la página anfitriona —y la inyección
 * de prompt no tiene hoy una defensa completa— la única forma de que eso se convierta
 * en daño real es que el chatbot muestre un enlace de phishing con la apariencia de un
 * enlace oficial de la Alcaldía.
 *
 * Por eso todo enlace que venga del texto del modelo se valida contra la lista blanca
 * de `chatbotConfig.json > security.allowedLinkHosts`. Un destino fuera de la lista NO
 * se convierte en `<a href>`: se muestra como texto plano con un aviso visible, para
 * que el ciudadano vea la dirección pero no pueda pulsarla por error.
 *
 * Nota: no se usa `dangerouslySetInnerHTML` en ningún punto. El analizador construye
 * elementos de React, así que el escape de HTML lo hace React y no hay superficie de
 * XSS por interpolación.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Un solo recorrido reconoce: enlace Markdown, negrilla y URL suelta.
 * Los grupos son, en orden:
 *   1: enlace completo   2: etiqueta   3: URL
 *   4: negrilla completa 5: texto en negrilla
 *   6: URL suelta
 */
const TOKEN_REGEX = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([\s\S]+?)\*\*)|(https?:\/\/[^\s)]+)/g;

/** Detecta una viñeta al inicio de línea (`* ` o `- `). */
const BULLET_REGEX = /^\s*[*-]\s+/;

const linkStyle = (isUser) => ({
  color: isUser ? "#ffffff" : "#1d4ed8",
  fontWeight: 700,
  textDecoration: "underline",
  wordBreak: "break-all"
});

const blockedLinkStyle = {
  color: "#b45309",
  fontWeight: 600,
  wordBreak: "break-all",
  backgroundColor: "rgba(217, 119, 6, 0.12)",
  borderRadius: "4px",
  padding: "1px 4px"
};

/**
 * Renderiza un enlace, o un aviso si el destino no está autorizado.
 *
 * @param {Object} params
 * @param {string} params.label
 * @param {string} params.rawUrl
 * @param {boolean} params.isUser
 * @param {string} params.key
 */
const renderLink = ({ label, rawUrl, isUser, key }) => {
  const baseOrigin = globalThis.window?.location?.origin;
  const { safe, href } = forModelOutput(rawUrl, { baseOrigin });

  if (!safe) {
    // Destino no autorizado: se muestra pero no se puede pulsar.
    let host = rawUrl;
    try {
      host = new URL(rawUrl, baseOrigin).host || rawUrl;
    } catch {
      /* se deja el texto crudo */
    }
    return (
      <span key={key} style={blockedLinkStyle} title={`Enlace no verificado: ${rawUrl}`}>
        <ShieldAlert size={12} style={{ verticalAlign: "-2px", marginRight: "3px" }} />
        {label} (enlace externo no verificado: {host})
      </span>
    );
  }

  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" style={linkStyle(isUser)}>
      {label} 🔗
    </a>
  );
};

/**
 * Convierte una línea de texto en elementos de React.
 *
 * @param {string} line
 * @param {Object} opts
 * @param {boolean} opts.isUser
 * @param {number} opts.lineIdx
 * @returns {Array<string|JSX.Element>}
 */
const parseInline = (line, { isUser, lineIdx }) => {
  if (!line) return [];

  const elements = [];
  let lastIndex = 0;
  let match;

  // `exec` en bucle requiere un lastIndex limpio: la regex es de módulo y `g`.
  TOKEN_REGEX.lastIndex = 0;

  while ((match = TOKEN_REGEX.exec(line)) !== null) {
    if (match.index > lastIndex) {
      elements.push(line.substring(lastIndex, match.index));
    }

    if (match[1]) {
      elements.push(
        renderLink({
          label: match[2],
          rawUrl: match[3],
          isUser,
          key: `link-${lineIdx}-${match.index}`
        })
      );
    } else if (match[4]) {
      elements.push(
        <strong key={`bold-${lineIdx}-${match.index}`} style={{ fontWeight: 700 }}>
          {match[5]}
        </strong>
      );
    } else if (match[6]) {
      elements.push(
        renderLink({
          label: match[6],
          rawUrl: match[6],
          isUser,
          key: `rawlink-${lineIdx}-${match.index}`
        })
      );
    }

    lastIndex = TOKEN_REGEX.lastIndex;
  }

  if (lastIndex < line.length) {
    elements.push(line.substring(lastIndex));
  }

  return elements;
};

/**
 * Renderiza un texto multilínea con formato ligero.
 *
 * Interna a propósito: este archivo solo exporta el componente `RichText`, para
 * cumplir la regla de Fast Refresh (un módulo con componentes no debe exportar
 * además funciones auxiliares).
 *
 * @param {string} content
 * @param {Object} [opts]
 * @param {boolean} [opts.isUser]
 * @returns {JSX.Element[]|null}
 */
const renderRichText = (content, { isUser = false } = {}) => {
  if (!content) return null;

  const lines = String(content).split("\n");

  return lines.map((line, lineIdx) => {
    const isBullet = BULLET_REGEX.test(line);
    const cleanLine = isBullet ? line.replace(BULLET_REGEX, "") : line;

    return (
      <span
        key={lineIdx}
        style={{
          display: "block",
          marginBottom: lineIdx < lines.length - 1 ? "4px" : "0",
          paddingLeft: isBullet ? "12px" : "0"
        }}
      >
        {isBullet && (
          <span
            style={{
              fontWeight: "bold",
              marginRight: "6px",
              color: isUser ? "#ffffff" : "#3b82f6"
            }}
          >
            •
          </span>
        )}
        {parseInline(cleanLine, { isUser, lineIdx })}
      </span>
    );
  });
};

/**
 * Texto del mensaje con formato ligero: negrillas, viñetas y enlaces verificados.
 * @param {{content: string, isUser?: boolean}} props
 */
export const RichText = ({ content, isUser = false }) => <>{renderRichText(content, { isUser })}</>;
