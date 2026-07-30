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
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("gemini_api_key") || "");
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

  // Helper para añadir mensaje
  const addMessage = (msg) => {
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

  // Obtener contexto de la página principal donde está embebido el chatbot
  const getPageContext = () => {
    try {
      const title = document.title || "Portal de Atención Digital";
      const url = window.location.href;
      
      // Intentar obtener descripción de meta tags
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || "";
      
      // Obtener textos de encabezados principales para dar contexto de secciones
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => h.innerText.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(', ');

      // Intentar leer el contenido de la consola o la página en texto (evitando el widget del chat en sí)
      const pageText = document.getElementById("root")?.innerText ? document.getElementById("root").innerText.substring(0, 1000) : "";

      return `[METADATOS DE LA PÁGINA]:
- Título: "${title}"
- URL: ${url}
- Descripción: "${metaDescription}"
- Encabezados detectados: [${headings}]
- Extracto de contenido de la página: "${pageText.replace(/\s+/g, ' ').substring(0, 500)}..."`;
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

  const handlePredialStreamEvent = (evt, contextData = {}, statusMsgId) => {
    const { event, outcome, amount, filename, payment_url, payment_qr, message, session_id, predios } = evt;

    const MENSAJES_PROGRESO = {
      started: "🔍 Consultando la información de tu predio...",
      portal_ready: "📑 Verificando registros...",
      invoice_ready: "📊 Calculando impuestos y vigencias..."
    };

    if (MENSAJES_PROGRESO[event] && statusMsgId) {
      updateMessage(statusMsgId, { text: MENSAJES_PROGRESO[event] });
      return;
    }

    if (event === "search_done") {
      if (outcome === "predio_unico" && statusMsgId) {
        updateMessage(statusMsgId, { text: "✅ Predio ubicado. Solicitando estado de cuenta..." });
      } else if (outcome === "multiples_predios" && statusMsgId) {
        const rawPredios = predios || evt.result?.predios || [];
        const rawSession = session_id || evt.result?.session_id;

        updateMessage(statusMsgId, {
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

      if (statusMsgId) {
        updateMessage(statusMsgId, {
          text: `📄 ¡Listo! Tu factura fue generada exitosamente por un total de ${montoFormateado}. Te la adjunto a continuación:`,
          attachment: {
            type: "file",
            fileUrl: pdfUrl,
            fileLabel: `📥 Descargar Factura PDF (${filename || "Factura.pdf"})`
          }
        });
      }
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

      if (statusMsgId) {
        updateMessage(statusMsgId, { text: `⚠️ ${humanMsg}` });
      } else {
        addMessage({ sender: "bot", text: `⚠️ ${humanMsg}` });
      }
    }
  };

  const handlePredialFormSubmit = async ({ searchType, searchValue, phone, email, cliente = "floridablanca" }) => {
    addMessage({
      sender: "user",
      text: `Consulta Predial (${searchType}: ${searchValue})`
    });

    setIsLoading(true);

    const statusMsgId = addMessage({
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
          (evt) => handlePredialStreamEvent(evt, { phone, email }, statusMsgId),
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

      updateMessage(statusMsgId, { text: `⚠️ ${humanMsg}` });
    }
  };

  const handleSelectPredio = async (index, sessionId, contextData = {}) => {
    setIsLoading(true);

    const statusMsgId = addMessage({
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
          (evt) => handlePredialStreamEvent(evt, contextData, statusMsgId),
          (err) => {
            console.error("Error en SSE Stream Selección Predial:", err);
            setIsLoading(false);
          }
        );
      }
    } catch (error) {
      console.error("Error seleccionando predio:", error);
      setIsLoading(false);
      updateMessage(statusMsgId, { text: `⚠️ ${error.message}` });
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
        const pageContext = getPageContext();

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
      // Siempre devolver las opciones rápidas al finalizar un flujo de formulario
      setTimeout(() => {
        const replies = isServicesEnabled 
          ? config.quickReplies.map(reply => reply.label)
          : null;

        addMessage({
          sender: "bot",
          text: isServicesEnabled 
            ? "¿Te puedo ayudar con algo más? Escribe tu duda o selecciona una opción rápida:"
            : "¿Te puedo ayudar con algo más?",
          quickReplies: replies
        });
      }, 1000);
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
        handleSelectPredio,
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
