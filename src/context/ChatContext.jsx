/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useRef } from "react";
import { queryGemini } from "../services/gemini";
import { getPredialInfo, getSisbenInfo, runRpaProcess } from "../services/apiMock";
import {
  generarFacturaAsync,
  listenJobStream,
  seleccionarPredio,
  formatPesos,
  getFacturaPdfUrl
} from "../services/rpaPredialService";
import { containsFuzzyKeyword } from "../utils/stringUtils";
import { getSemanticRoute } from "../services/intentRouter";
import { consultarPqrsd } from "../services/pqrsdService";
import config from "../config/chatbotConfig.json";

const ChatContext = createContext();

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat debe usarse dentro de un ChatProvider");
  }
  return context;
};

const getInitialWelcomeMessages = (isServicesEnabled) => {
  const replies = [];
  if (isServicesEnabled) {
    config.quickReplies.forEach(reply => {
      replies.push(reply.label);
    });
  }

  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return [
    {
      id: "welcome-privacy",
      sender: "system",
      text: config.welcome.privacyNotice || "🔒 Aviso de Privacidad: Al enviar tu primer mensaje o seleccionar una opción, autorizas el Tratamiento de Datos Personales (Ley 1581 de 2012) y aceptas los Términos y Condiciones.",
      timestamp: now
    },
    {
      id: "welcome-1",
      sender: "bot",
      text: config.welcome.message1,
      timestamp: now
    },
    {
      id: "welcome-2",
      sender: "bot",
      text: isServicesEnabled 
        ? config.welcome.message2_services
        : config.welcome.message2_no_services,
      timestamp: now,
      quickReplies: replies.length > 0 ? replies : null
    }
  ];
};

export const ChatProvider = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState(() => getInitialWelcomeMessages(true));
  const [isTextInputEnabled, setIsTextInputEnabled] = useState(true); // Teclado siempre habilitado por defecto
  const [apiKey, setApiKeyState] = useState(
    localStorage.getItem("gemini_api_key") || import.meta.env.VITE_GEMINI_API_KEY || ""
  );
  const [tokensSavedTotal, setTokensSavedTotal] = useState(0);
  const [tokensUsedTotal, setTokensUsedTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [lastServiceMentioned, setLastServiceMentioned] = useState(null);
  const [activeContext, setActiveContext] = useState(null);

  // Theme (light | dark) defaulting to 'light'
  const [theme, setTheme] = useState(localStorage.getItem("chatbot_theme") || "light");

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("chatbot_theme", nextTheme);
  };

  // Toggles de Módulos (Habilitar/Deshabilitar en caliente desde la consola)
  const [isGeminiEnabled, setIsGeminiEnabled] = useState(true);
  const [isServicesEnabled, setIsServicesEnabled] = useState(true);

  // Inicializar chat con mensajes de bienvenida adaptados desde JSON
  const initChat = () => {
    setIsTextInputEnabled(true);
    setMessages(getInitialWelcomeMessages(isServicesEnabled));
  };

  // Reiniciar el chat si cambia el estado de algún módulo para refrescar las sugerencias
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setIsTextInputEnabled(true);
    setMessages(getInitialWelcomeMessages(isServicesEnabled));
  }, [isServicesEnabled, isGeminiEnabled]);

  // Actualizar API Key
  const updateApiKey = (key) => {
    setApiKeyState(key);
    localStorage.setItem("gemini_api_key", key);
  };

  // Función para registrar el uso de tokens en un archivo log del servidor (Req 3)
  const logTokenUsage = async (prompt, used, saved) => {
    try {
      await fetch("/api/log-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, used, saved })
      });
    } catch (e) {
      console.warn("No se pudo registrar el token en el servidor local:", e.message);
    }
  };

  // Temporizador para mensaje de seguimiento ("¿Te puedo ayudar con algo más?") tras 20s de inactividad
  const followUpTimerRef = useRef(null);

  const clearFollowUpTimer = () => {
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  };

  const scheduleFollowUp = (delayMs = 20000) => {
    clearFollowUpTimer();
    followUpTimerRef.current = setTimeout(() => {
      setMessages((prevMessages) => {
        if (prevMessages.length === 0) return prevMessages;
        const lastMsg = prevMessages[prevMessages.length - 1];
        if (lastMsg.sender === "bot" && !lastMsg.text?.includes("¿Te puedo ayudar con algo más?")) {
          const replies = isServicesEnabled ? config.quickReplies.map(reply => reply.label) : null;
          const newMsg = {
            id: Math.random().toString(36).substr(2, 9),
            sender: "bot",
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            text: isServicesEnabled 
              ? "¿Te puedo ayudar con algo más? Escribe tu duda o selecciona una opción rápida:"
              : "¿Te puedo ayudar con algo más?",
            quickReplies: replies
          };
          return [...prevMessages.map(m => ({ ...m, quickReplies: null })), newMsg];
        }
        return prevMessages;
      });
    }, delayMs);
  };

  // Helper para añadir mensaje
  const addMessage = (msg) => {
    if (msg.sender === "user") {
      clearFollowUpTimer();
    }
    const id = msg.id || Math.random().toString(36).substr(2, 9);
    setMessages((prev) => [
      ...prev.map(m => ({ ...m, quickReplies: null })), // Quitar botones de mensajes antiguos
      {
        id,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        ...msg
      }
    ]);
    return id;
  };

  // Helper para actualizar dinámicamente un mensaje existente (Opción A)
  const updateMessage = (id, updates) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg))
    );
  };

  const [sitemapLinks, setSitemapLinks] = useState([]);

  // Cargar silenciosamente en segundo plano los enlaces del mapa del sitio o menú del portal
  useEffect(() => {
    const loadSitemapLinks = async () => {
      try {
        const origin = window.location.origin;
        const possiblePaths = [
          "/mapa-del-sitio",
          "/mapa-sitio",
          "/mapa-de-sitio",
          "/sitemap"
        ];

        let html = "";
        let finalSitemapUrl = "";

        for (const path of possiblePaths) {
          try {
            const res = await fetch(`${origin}${path}`, { method: "GET" });
            if (res.ok) {
              const text = await res.text();
              if (text.length > 500 && !text.includes("404") && !text.includes("Página no encontrada")) {
                html = text;
                finalSitemapUrl = `${origin}${path}`;
                break;
              }
            }
          } catch {
            // Probar siguiente ruta
          }
        }

        if (!html) {
          // Fallback a los enlaces navegables del DOM actual
          const domLinks = Array.from(document.querySelectorAll("nav a[href], header a[href], main a[href], footer a[href], .menu a[href]"))
            .map(a => ({
              title: (a.innerText || a.getAttribute("title") || "").trim(),
              url: a.href
            }))
            .filter(item => 
              item.title.length > 2 && 
              item.url.startsWith("http") && 
              !item.url.includes("#") && 
              !item.url.includes("javascript:")
            );
          
          console.log("ℹ️ [Sitemap] Enlaces extraídos directamente del DOM de la página:", domLinks);
          setSitemapLinks(domLinks.slice(0, 50));
          return;
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const sitemapContainer = doc.querySelector(".mapa-del-sitio, .sitemap, main, #main-content, #content, body");
        const rawAnchors = Array.from((sitemapContainer || doc).querySelectorAll("a[href]"));

        const links = rawAnchors
          .map(a => {
            let href = a.getAttribute("href") || "";
            if (href.startsWith("/")) {
              href = `${origin}${href}`;
            } else if (!href.startsWith("http")) {
              href = `${origin}/${href.replace(/^\.\//, "")}`;
            }
            
            const title = (a.innerText || a.textContent || a.getAttribute("title") || "").trim().replace(/\s+/g, " ");

            return {
              title: title,
              url: href
            };
          })
          .filter(item => 
            item.title.length > 2 && 
            item.url.startsWith("http") && 
            !item.url.includes("#") && 
            !item.url.includes("javascript:") &&
            !item.url.endsWith(".png") &&
            !item.url.endsWith(".jpg")
          );

        const uniqueLinks = [];
        const seen = new Set();
        for (const link of links) {
          if (!seen.has(link.url)) {
            seen.add(link.url);
            uniqueLinks.push(link);
          }
        }

        console.log(`🗺️ [Sitemap] Enlaces extraídos exitosamente desde ${finalSitemapUrl}:`, uniqueLinks);
        setSitemapLinks(uniqueLinks.slice(0, 60));
      } catch (e) {
        console.warn("⚠️ [Sitemap] Error al cargar mapa del sitio:", e.message);
      }
    };

    loadSitemapLinks();
  }, []);

  // Filtrar localmente en JS los enlaces más relevantes comparando títulos y slugs de URL
  const filterRelevantSitemapLinks = (userText, links) => {
    if (!userText || !links || links.length === 0) return [];
    
    const cleanMsg = userText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const stopWords = ["para", "como", "donde", "quiero", "puedo", "hacer", "pasame", "enlace", "link", "buscar", "pagina", "sitio", "favor", "dame", "esta", "este"];
    const words = cleanMsg.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));
    
    if (words.length === 0) return [];

    const matched = [];
    for (const link of links) {
      const cleanTitle = link.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const cleanUrl = link.url.toLowerCase();
      let matchScore = 0;

      for (const w of words) {
        if (cleanTitle.includes(w)) matchScore += w.length * 2;
        if (cleanUrl.includes(w)) matchScore += w.length;
      }
      
      if (matchScore > 0) {
        matched.push({ ...link, score: matchScore });
      }
    }
    return matched.sort((a, b) => b.score - a.score).slice(0, 3);
  };

  // Obtener contexto de la página principal filtrando únicamente enlaces relevantes
  const getPageContext = (userMessage = "") => {
    try {
      const title = document.title || "Portal de Atención Digital";
      const url = window.location.href;
      const origin = window.location.origin;
      const sitemapUrl = `${origin}/mapa-del-sitio`;
      
      const searchQuery = encodeURIComponent(userMessage.replace(/(pasame|dame|el|link|enlace|de|por|favor|dónde|donde|está|busco)/gi, "").trim() || "tramites");
      const fallbackSearchUrl = `${origin}/buscar/?q=${searchQuery}`;

      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || "";
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => h.innerText.trim())
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');

      const relevantLinks = filterRelevantSitemapLinks(userMessage, sitemapLinks);
      
      let linksFormatted = "";
      if (relevantLinks.length > 0) {
        linksFormatted = relevantLinks.map(l => `- "${l.title}": ${l.url}`).join("\n");
      } else {
        linksFormatted = `- No se encontró coincidencia directa en el mapa del sitio.\n- Enlace de Búsqueda Fallback en el Portal: ${fallbackSearchUrl}`;
      }

      return `[METADATOS DE LA PÁGINA]:
- Título de la página: "${title}"
- URL Actual: ${url}
- Dominio Origen: ${origin}
- URL Mapa del Sitio: ${sitemapUrl}

[ENLACES RELEVANTES ENCONTRADOS PARA LA CONSULTA]:
${linksFormatted}

- Descripción: "${metaDescription}"
- Encabezados principales: [${headings}]`;
    } catch (e) {
      console.warn("No se pudo obtener el contexto de la página principal:", e);
      return "Contexto de página no disponible.";
    }
  };

  // Funciones de flujo parametrizadas
  const startSisbenFlow = () => {
    addMessage({
      sender: "bot",
      text: "Para consultar tu Sisbén en Floridablanca, ingresa tu número de documento de identidad:",
      form: {
        type: "sisben",
        fields: [{ name: "documento", placeholder: "Número de cédula o tarjeta", type: "text", required: true }]
      }
    });
  };

  const startPredialFlow = () => {
    addMessage({
      sender: "bot",
      text: "Diligencia los siguientes datos para consultar y generar la factura del Impuesto Predial en Floridablanca:",
      customComponent: "predial_form"
    });
  };

  const handlePredialStreamEvent = (evt, contextData = {}) => {
    const { event, outcome, amount, filename, payment_url, payment_qr, message, session_id, predios } = evt;

    const MENSAJES_PROGRESO = {
      started: "🔍 Consultando la información de tu predio...",
      portal_ready: "📑 Verificando registros...",
      invoice_ready: "📊 Calculando impuestos y vigencias..."
    };

    if (MENSAJES_PROGRESO[event]) {
      addMessage({ sender: "bot", text: MENSAJES_PROGRESO[event] });
      return;
    }

    if (event === "search_done") {
      if (outcome === "predio_unico") {
        addMessage({ sender: "bot", text: "✅ Predio ubicado. Solicitando estado de cuenta..." });
      } else if (outcome === "multiples_predios") {
        const rawPredios = predios || evt.result?.predios || [];
        const rawSession = session_id || evt.result?.session_id;

        addMessage({
          sender: "bot",
          text: `🏢 Se encontraron ${rawPredios.length} predios registrados para esta consulta. Selecciona tu inmueble a continuación:`,
          customComponent: "predial_multiples",
          sessionId: rawSession,
          predios: rawPredios,
          predialContext: contextData
        });
      } else if (outcome === "no_encontrado") {
        setIsLoading(false);
      }
      return;
    }

    if (event === "pdf_ready") {
      const montoFormateado = amount ? formatPesos(amount) : "monto liquidado";
      const pdfUrl = getFacturaPdfUrl(filename);

      addMessage({
        sender: "bot",
        text: `📄 ¡Listo! Tu factura fue generada exitosamente por un total de ${montoFormateado}. Te la adjunto a continuación:`,
        attachment: {
          type: "file",
          fileUrl: pdfUrl,
          fileLabel: `📥 Descargar Factura PDF (${filename || "Factura.pdf"})`
        }
      });
      return;
    }

    if (event === "payment_ready") {
      if (payment_url) {
        addMessage({
          sender: "bot",
          text: "Y acá tienes el enlace oficial para pagar en línea mediante PSE:",
          buttonUrl: payment_url,
          buttonText: "💳 Ir a Pagar en Línea (PSE)"
        });
      }
      if (payment_qr) {
        addMessage({
          sender: "bot",
          text: "También puedes escanear este código QR directamente para realizar tu pago:",
          attachment: {
            type: "image",
            src: payment_qr,
            label: "Código QR para Pago PSE"
          }
        });
      }
      return;
    }

    if (event === "done") {
      setIsLoading(false);
      scheduleFollowUp(20000);
      return;
    }

    if (event === "error") {
      setIsLoading(false);
      let humanMsg = message || "Error durante la generación de la factura.";
      if (humanMsg.includes("pasarela de pago")) {
        humanMsg = "Ya hay un pago en proceso para este predio. Si acabas de generar la factura, usa ese link; si no, intenta en 1 hora.";
      } else if (humanMsg.includes("Generar Factura' no se habilitó")) {
        humanMsg = "¡Buenas noticias! Este predio se encuentra al día (Paz y Salvo), no registra deuda pendiente.";
      } else if (humanMsg.includes("No se encontró el valor")) {
        humanMsg = "No encontré ese predio en Floridablanca. Por favor verifica el número o intenta por otro dato.";
      }

      addMessage({ sender: "bot", text: `⚠️ ${humanMsg}` });
      scheduleFollowUp(20000);
    }
  };

  const handlePredialFormSubmit = async ({ searchType, searchValue, phone, email, cliente = "floridablanca" }) => {
    addMessage({
      sender: "user",
      text: `Consulta Predial (${searchType}: ${searchValue})`
    });

    setIsLoading(true);

    addMessage({
      sender: "bot",
      text: "🔍 Consultando la información de tu predio..."
    });

    try {
      const resp = await generarFacturaAsync({
        searchType,
        searchValue,
        phone,
        email,
        cliente
      });

      if (resp && resp.job_id) {
        listenJobStream(
          resp.job_id,
          (evt) => handlePredialStreamEvent(evt, { phone, email }),
          (err) => {
            console.error("Error en SSE Stream Predial:", err);
            setIsLoading(false);
          }
        );
      }
    } catch (error) {
      console.error("Error iniciando trámite Predial:", error);
      setIsLoading(false);

      let humanMsg = error.message;
      if (humanMsg.includes("pasarela de pago")) {
        humanMsg = "Ya hay una transacción PSE en proceso para este predio. Si acabas de generar la factura, usa ese link; si no, intenta nuevamente en 1 hora.";
      } else if (humanMsg.includes("Generar Factura' no se habilitó")) {
        humanMsg = "¡Buenas noticias! Este predio se encuentra al día (Paz y Salvo), no registra deuda pendiente.";
      } else if (humanMsg.includes("No se encontró el valor de búsqueda")) {
        humanMsg = `No se encontró el predio con ${searchType}: "${searchValue}" en Floridablanca.`;
      }

      addMessage({ sender: "bot", text: `⚠️ ${humanMsg}` });
    }
  };

  const handleSelectPredio = async (index, sessionId, contextData = {}) => {
    setIsLoading(true);

    addMessage({
      sender: "bot",
      text: `📊 Calculando impuestos y vigencias para el predio #${index + 1}...`
    });

    try {
      const resp = await seleccionarPredio({
        sessionId,
        index,
        phone: contextData.phone || "3000000000",
        email: contextData.email || "correo@ejemplo.com",
        mode: "async"
      });

      if (resp && resp.job_id) {
        listenJobStream(
          resp.job_id,
          (evt) => handlePredialStreamEvent(evt, contextData),
          (err) => {
            console.error("Error en SSE Stream Selección Predial:", err);
            setIsLoading(false);
          }
        );
      }
    } catch (error) {
      console.error("Error seleccionando predio:", error);
      setIsLoading(false);
      addMessage({ sender: "bot", text: `⚠️ ${error.message}` });
    }
  };



  const startPqrsdCreateFlow = () => {
    addMessage({
      sender: "bot",
      text: "Diligencia el siguiente formulario para radicar tu PQRSD en la Alcaldía de Floridablanca:",
      customComponent: "pqrsd_crear"
    });
  };

  const startPqrsdConsultFlow = () => {
    addMessage({
      sender: "bot",
      text: "Digita tu número de radicado y tu código de seguridad suministrado al radicar la PQRSD.",
      customComponent: "pqrsd_consult"
    });
  };

  const handlePqrsdConsultSubmit = async ({ radicado, codigoAutenticacion }) => {
    addMessage({
      sender: "user",
      text: `🔍 Consulta PQRSD (Radicado: ${radicado})`
    });

    setIsLoading(true);

    addMessage({
      sender: "bot",
      text: `🔍 Buscando la información de la PQRSD radicado #${radicado}...`
    });

    try {
      const res = await consultarPqrsd(radicado, codigoAutenticacion);

      if (res && res.found) {
        addMessage({
          sender: "bot",
          text: `📑 Aquí tienes los detalles y la trazabilidad de tu PQRSD (Radicado #${radicado}):`,
          customComponent: "pqrsd_result",
          pqrsdData: res
        });
      } else {
        addMessage({
          sender: "bot",
          text: `⚠️ ${res?.message || "No se encontró ningún radicado con los datos ingresados. Verifica el número de radicado y el código de seguridad."}`
        });
      }
    } catch (err) {
      addMessage({
        sender: "bot",
        text: `⚠️ Ocurrió un error al consultar la PQRSD radicado #${radicado}: ${err.message || "Error de conexión."}`
      });
    } finally {
      setIsLoading(false);
      scheduleFollowUp(20000);
    }
  };

  const startPqrsdGeneralFlow = () => {
    addMessage({
      sender: "bot",
      text: "¿Qué trámite de PQRSD deseas realizar en la Alcaldía de Floridablanca?",
      quickReplies: [
        "📑 Radicar PQRSD",
        "🔍 Consultar PQRSD"
      ]
    });
  };

  // Palabras clave de activación del flujo interactivo
  const ACTIVATION_KEYWORDS = [
    "nuevamente",
    "otra vez",
    "de nuevo",
    "iniciar",
    "ejecutar",
    "formulario",
    "comenzar",
    "procesar",
    "abrir"
  ];

  // Enrutador semántico de intenciones
  const handleSemanticRouting = async (text) => {
    const route = getSemanticRoute(text);
    const cleanText = text.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // Validar si el texto contiene alguna palabra de activación usando Fuzzy Match
    const hasActivationKeyword = containsFuzzyKeyword(cleanText, ACTIVATION_KEYWORDS);
    
    // Determinar qué servicio activar (ruta directa detectada o servicio pendiente si dice "iniciar")
    const serviceToTrigger = route || (hasActivationKeyword ? lastServiceMentioned : null);
    
    if (serviceToTrigger === "sisben") {
      startSisbenFlow();
      setLastServiceMentioned(null);
      setIsLoading(false);
      return { routed: true };
    }
    
    if (serviceToTrigger === "predial") {
      startPredialFlow();
      setLastServiceMentioned(null);
      setIsLoading(false);
      return { routed: true };
    }
    
    if (serviceToTrigger === "pqrsd_crear") {
      startPqrsdCreateFlow();
      setLastServiceMentioned(null);
      setIsLoading(false);
      return { routed: true };
    }

    if (serviceToTrigger === "pqrsd_consultar") {
      startPqrsdConsultFlow();
      setLastServiceMentioned(null);
      setIsLoading(false);
      return { routed: true };
    }

    if (serviceToTrigger === "pqrsd" || serviceToTrigger === "rpa") {
      startPqrsdGeneralFlow();
      setLastServiceMentioned(null);
      setIsLoading(false);
      return { routed: true };
    }
    
    return { routed: false };
  };

  // Enviar mensaje de texto libre
  const sendMessage = async (text, skipAddUserMessage = false) => {
    if (!text || text.trim() === "") return;

    // Añadir mensaje del usuario (a menos que ya se haya añadido en el Quick Reply)
    if (!skipAddUserMessage) {
      addMessage({ sender: "user", text });
    }
    setIsLoading(true);

    try {
      let currentPendingRoute = null;

      // 1. Intentar enrutamiento semántico local (solo si servicios están habilitados)
      if (isServicesEnabled) {
        const routeResult = await handleSemanticRouting(text);
        if (routeResult.routed) return;
        if (routeResult.pendingRoute) currentPendingRoute = routeResult.pendingRoute;
      } else {
        // Si servicios están deshabilitados pero el usuario pregunta por un trámite
        const cleanText = text.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const serviceKeywords = ["sisben", "predial", "rpa", "impuesto", "pagar", "reporte", "robot"];
        const isServiceKeyword = containsFuzzyKeyword(cleanText, serviceKeywords);
        if (isServiceKeyword) {
          addMessage({
            sender: "bot",
            text: "⚠️ Los servicios y trámites interactivos están inhabilitados temporalmente por el administrador."
          });
          setIsLoading(false);
          return;
        }
      }

      // 2. Si no es un trámite directo, verificar si la IA de Gemini está habilitada
      if (isGeminiEnabled) {
        const pageContext = getPageContext(text);

        const conversationHistory = messages
          .filter(m => m.sender === "user" || m.sender === "bot")
          .map(m => ({ sender: m.sender, text: m.text }));
        
        conversationHistory.push({ sender: "user", text });

        const geminiResponse = await queryGemini(conversationHistory, apiKey, pageContext, activeContext);
        
        // Actualizar la memoria de contexto si la respuesta tiene una intención
        if (geminiResponse.contextIntent) {
          setActiveContext(geminiResponse.contextIntent);
        }

        let replyText = geminiResponse.text;
        
        // Si el usuario acaba de preguntar por el servicio (sin activarlo) y guardamos la intención
        const serviceToCheck = currentPendingRoute;
        if (serviceToCheck) {
          const serviceName = serviceToCheck === "predial" 
            ? "Impuesto Predial" 
            : (serviceToCheck === "sisben" ? "Sisbén" : "PQRSD");
          replyText += `\n\n*(Escribe "iniciar" para realizar el trámite interactivo de ${serviceName} aquí mismo)*`;
        }

        addMessage({
          sender: "bot",
          text: replyText
        });

        // Registrar en el archivo log y actualizar contadores de tokens (Req 3)
        if (geminiResponse.tokensUsed) {
          logTokenUsage(text, geminiResponse.tokensUsed, geminiResponse.savedTokens);
          setTokensUsedTotal((prev) => prev + geminiResponse.tokensUsed);
          setTokensSavedTotal((prev) => prev + geminiResponse.savedTokens);
        }
      } else {
        addMessage({
          sender: "bot",
          text: "⚠️ La sección de preguntas frecuentes y respuesta libre con IA está inhabilitada en este momento. Por favor utiliza los trámites habilitados."
        });
      }

    } catch {
      addMessage({
        sender: "bot",
        text: "⚠️ Hubo un inconveniente al procesar tu solicitud. Por favor intenta de nuevo."
      });
    } finally {
      setIsLoading(false);
      scheduleFollowUp(20000);
    }
  };

  // Manejar click en Quick Reply
  const selectQuickReply = async (option) => {
    addMessage({ sender: "user", text: option });
    setIsLoading(true);

    // Pequeño delay de experiencia de usuario
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (!isServicesEnabled) {
      addMessage({
        sender: "bot",
        text: "⚠️ Los servicios y trámites interactivos están inhabilitados en este momento."
      });
      setIsLoading(false);
      return;
    }

    // Ejecutar enrutamiento semántico para la opción seleccionada
    const routeResult = await handleSemanticRouting(option);
    if (!routeResult.routed) {
      // Si no coincide con un trámite local directo, enviar a flujo normal de Gemini
      sendMessage(option, true); // Pasar true para no duplicar el mensaje del usuario
    }
  };

  // Enviar formulario interactivo en el chat (Req 4 y Req 5)
  const submitChatForm = async (formType, formData) => {
    setIsLoading(true);

    try {
      if (formType === "predial") {
        const doc = formData.documento;
        const result = await getPredialInfo(doc);

        addMessage({
          sender: "bot",
          text: `Predio de ${result.propietario} ubicado en ${result.direccion}. Estado: ${result.estado}. Valor: $${result.valor.toLocaleString()}.`,
          attachment: {
            type: "image",
            src: result.productoImagen,
            label: "Predio Registrado",
            fileUrl: result.facturaUrl,
            fileLabel: result.estado === "Pendiente" ? "📥 Descargar Factura PDF" : "📥 Descargar Recibo de Pago"
          }
        });
      } 
      else if (formType === "sisben") {
        const doc = formData.documento;
        const result = await getSisbenInfo(doc);

        addMessage({
          sender: "bot",
          text: `Ciudadano: ${result.nombre}. Clasificación Sisbén IV: Grupo ${result.grupo} (${result.clasificacion}). Actualizado el ${result.ultimaActualizacion}.`,
          attachment: {
            type: "image",
            src: result.imagenGrupo,
            label: `Certificado Grupo ${result.grupo}`,
            fileUrl: result.certificadoUrl,
            fileLabel: "📥 Descargar Certificado de Afiliación PDF"
          }
        });
      } 
      else if (formType === "rpa") {
        // Ejecución de logs animados de RPA en el chat
        addMessage({
          sender: "system",
          text: "🤖 Iniciando robot RPA para compilación de reporte..."
        });

        const rpaResult = await runRpaProcess(formData, (logStep) => {
          // Callback para cada paso de RPA
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substr(2, 9),
              sender: "system",
              text: logStep,
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }
          ]);
        });

        // Gemini responde en lenguaje natural la confirmación final de forma muy corta (Req 4 + Req 3)
        const systemMessageRpa = `El robot de RPA ha terminado con éxito. Detalle: ${rpaResult.message}.`;
        const geminiRpaText = await queryGemini(
          [{ sender: "system", text: systemMessageRpa }, { sender: "user", text: "Dame confirmación final del RPA." }],
          apiKey
        );

        if (geminiRpaText.tokensUsed) {
          logTokenUsage(`Confirmación RPA (${formData.periodo})`, geminiRpaText.tokensUsed, geminiRpaText.savedTokens);
          setTokensUsedTotal((prev) => prev + geminiRpaText.tokensUsed);
          setTokensSavedTotal((prev) => prev + geminiRpaText.savedTokens);
        }

        addMessage({
          sender: "bot",
          text: geminiRpaText.text,
          attachment: {
            type: "file",
            fileUrl: rpaResult.fileUrl,
            fileLabel: `📥 Descargar ${rpaResult.fileName}`
          }
        });
      }
    } catch (error) {
      addMessage({
        sender: "bot",
        text: `❌ Error: ${error.message}`
      });
    } finally {
      setIsLoading(false);
      scheduleFollowUp(20000);
    }
  };

  const openChat = () => setIsOpen(true);
  const closeChat = () => setIsOpen(false);
  const toggleChat = () => setIsOpen(!isOpen);
 
  return (
    <ChatContext.Provider
      value={{
        isOpen,
        messages,
        isTextInputEnabled,
        apiKey,
        tokensSavedTotal,
        tokensUsedTotal,
        isLoading,
        openChat,
        closeChat,
        toggleChat,
        sendMessage,
        selectQuickReply,
        submitChatForm,
        handlePredialFormSubmit,
        handlePqrsdConsultSubmit,
        handleSelectPredio,
        scheduleFollowUp,
        clearFollowUpTimer,
        updateApiKey,
        resetChat: initChat,
        isGeminiEnabled,
        setIsGeminiEnabled,
        isServicesEnabled,
        setIsServicesEnabled,
        theme,
        toggleTheme,
        setTheme
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};
