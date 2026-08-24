/**
 * Pruebas del servidor de Cloud Run (GOB-GCP-STD-01).
 *
 * Ejecuta:  node tests/run-server-tests.mjs
 *
 * Cubre el mínimo que exige el estándar para `tests/test_health.py`, traducido a Node:
 *   · /health responde 200 con {"status": "UP"}
 *   · /version responde 200 con service, version y environment
 *   · la respuesta incluye la cabecera X-Correlation-ID
 *   · si la petición trae X-Correlation-ID, la respuesta devuelve el MISMO valor
 *
 * Añade además las comprobaciones de seguridad del servidor: recorrido de rutas,
 * métodos no permitidos y formato de los logs.
 */

// Puerto alto y fijo para la prueba, para no chocar con el servidor de desarrollo.
const TEST_PORT = 8899;
process.env.PORT = String(TEST_PORT);
process.env.SERVICE_NAME = "ia-chatbot-floridablanca";
process.env.SERVICE_VERSION = "test-abc1234";
process.env.ENVIRONMENT = "local";
process.env.LOG_LEVEL = "ERROR"; // silenciar los logs de arranque durante las pruebas

// ── Configuración del proxy de IA para las pruebas ────────────────────────────
// Límites bajos a propósito: se quiere agotarlos en tres o cuatro llamadas.
process.env.AI_RATE_LIMIT_PER_MINUTE = "5";
process.env.AI_DAILY_QUOTA_PER_SESSION = "3";
process.env.AI_DAILY_TOKEN_CEILING = "1000";
process.env.ALLOWED_ORIGINS = ".floridablanca.gov.co";
process.env.TRUSTED_PROXY_HOPS = "2";
// Sin credencial: se comprueba que el proxy degrada en lugar de romperse.
delete process.env.GEMINI_API_KEY;

// ── Integración con los RPA ───────────────────────────────────────────────────
// Sin token y sin sonda de arranque: estas pruebas no tocan los servicios reales. La
// integración se prueba entera, con respuestas simuladas, en tests/run-rpa-tests.mjs.
process.env.RPA_AUTH_MODE = "none";
process.env.RPA_STARTUP_PROBE = "off";
process.env.RPA_FACTURA_URL = "http://localhost:8000";
process.env.RPA_PQRSD_URL = "http://localhost:8001";

const results = [];
let currentSection = "";

const section = (name) => {
  currentSection = name;
  console.log(`\n\x1b[1m\x1b[36m━━━ ${name} ━━━\x1b[0m`);
};
const check = (name, passed, detail = "") => {
  results.push({ section: currentSection, name, passed });
  console.log(`  [${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${name}`);
  if (detail) console.log(`         \x1b[90m${detail}\x1b[0m`);
};

const BASE = `http://127.0.0.1:${TEST_PORT}`;

// Importar arranca el servidor.
const { server } = await import("../server/index.js");
const { resolveStaticPath } = await import("../server/index.js");
const { parseCloudTraceContext, parseTraceparent, resolveContext } =
  await import("../server/correlation.js");

// Esperar a que el socket esté escuchando.
await new Promise((resolve) => {
  if (server.listening) return resolve();
  server.once("listening", resolve);
});

// ══════════════════════════════════════════════════════════════════════════════
section("1. Endpoints de infraestructura");
// ══════════════════════════════════════════════════════════════════════════════
{
  const res = await fetch(`${BASE}/health`);
  const body = await res.json();
  check("GET /health responde 200", res.status === 200, `status=${res.status}`);
  check('GET /health devuelve {"status":"UP"}', body.status === "UP", JSON.stringify(body));
  check("GET /health no se cachea", res.headers.get("cache-control") === "no-store");
}

{
  const res = await fetch(`${BASE}/version`);
  const body = await res.json();
  check("GET /version responde 200", res.status === 200);
  check("GET /version incluye service", body.service === "ia-chatbot-floridablanca", `service=${body.service}`);
  check("GET /version incluye version", body.version === "test-abc1234", `version=${body.version}`);
  check("GET /version incluye environment", body.environment === "local", `environment=${body.environment}`);
}

// ══════════════════════════════════════════════════════════════════════════════
section("2. Correlación de peticiones");
// ══════════════════════════════════════════════════════════════════════════════
{
  const res = await fetch(`${BASE}/health`);
  const generated = res.headers.get("x-correlation-id");
  check("la respuesta incluye X-Correlation-ID", Boolean(generated), `-> ${generated}`);
  check(
    "el identificador generado tiene forma de UUID v4",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generated || ""),
    `-> ${generated}`
  );

  // Dos peticiones sin cabecera deben recibir identificadores distintos.
  const res2 = await fetch(`${BASE}/health`);
  check(
    "cada petición recibe un identificador propio",
    generated !== res2.headers.get("x-correlation-id")
  );
}

{
  // Propagación: si viene, NO se sobrescribe.
  const incoming = "11111111-2222-4333-8444-555555555555";
  const res = await fetch(`${BASE}/health`, { headers: { "X-Correlation-ID": incoming } });
  check(
    "propaga el X-Correlation-ID recibido sin sobrescribirlo",
    res.headers.get("x-correlation-id") === incoming,
    `enviado=${incoming} devuelto=${res.headers.get("x-correlation-id")}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("3. Parseo de contexto de traza");
// ══════════════════════════════════════════════════════════════════════════════
{
  const gcp = parseCloudTraceContext("105445aa7843bc8bf206b12000100000/1;o=1");
  check(
    "parsea X-Cloud-Trace-Context (formato GCP)",
    gcp?.traceId === "105445aa7843bc8bf206b12000100000" && gcp?.spanId === "1",
    JSON.stringify(gcp)
  );

  const w3c = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  check(
    "parsea traceparent (formato W3C)",
    w3c?.traceId === "4bf92f3577b34da6a3ce929d0e0e4736" && w3c?.spanId === "00f067aa0ba902b7",
    JSON.stringify(w3c)
  );

  check("rechaza un traceparent malformado", parseTraceparent("basura") === null);
  check(
    "rechaza un trace-id todo a ceros (inválido por especificación)",
    parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01") === null
  );

  // El formato de GCP tiene prioridad: lo inyecta la propia infraestructura.
  const ctx = resolveContext({
    headers: {
      "x-cloud-trace-context": "aaaa/2;o=1",
      traceparent: "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01"
    }
  });
  check("X-Cloud-Trace-Context tiene prioridad sobre traceparent", ctx.traceId === "aaaa", `traceId=${ctx.traceId}`);
}

// ══════════════════════════════════════════════════════════════════════════════
section("4. Seguridad del servidor de archivos");
// ══════════════════════════════════════════════════════════════════════════════
{
  const root = "/srv/dist";
  const escapes = [
    "/../../etc/passwd",
    "/../server/index.js",
    "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/../../../../../../etc/shadow"
  ];
  for (const attempt of escapes) {
    const resolved = resolveStaticPath(attempt, root);
    check(
      `bloquea el recorrido de rutas: ${attempt.slice(0, 42)}`,
      resolved === null,
      resolved ? `RESUELVE A ${resolved}` : ""
    );
  }

  // Una ruta legítima sí debe resolverse.
  const ok = resolveStaticPath("/assets/main.js", root);
  check("permite rutas legítimas dentro de dist", typeof ok === "string" && ok.includes("assets"), `-> ${ok}`);

  // Un directorio hermano con prefijo común no debe colarse.
  check("no confunde un directorio hermano con prefijo común", resolveStaticPath("/../dist-malicioso/x", root) === null);
}

{
  const res = await fetch(`${BASE}/health`, { method: "POST" });
  check("rechaza métodos no permitidos con 405", res.status === 405, `status=${res.status}`);
}

{
  const res = await fetch(`${BASE}/health`);
  check("envía X-Content-Type-Options: nosniff", res.headers.get("x-content-type-options") === "nosniff");
  check(
    "no envía X-Frame-Options (rompería el widget embebido)",
    res.headers.get("x-frame-options") === null,
    "el widget debe poder incrustarse en portales de terceros"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("5. Limitadores: ventanas, cuotas y presupuesto");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { createRateLimiter, createDailyQuota, createTokenBudget, millisecondsUntilUtcMidnight } =
    await import("../server/rateLimit.js");

  // Reloj controlado: un limitador que dependa del reloj real no se puede probar.
  let clock = Date.UTC(2026, 7, 12, 10, 0, 0);
  const now = () => clock;

  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now });
  const results3 = [limiter.hit("ip-a"), limiter.hit("ip-a"), limiter.hit("ip-a")];
  const fourth = limiter.hit("ip-a");

  check(
    "permite justo hasta el tope y bloquea la siguiente",
    results3.every((r) => r.allowed) && !fourth.allowed,
    `permitidas=${results3.filter((r) => r.allowed).length} cuarta=${fourth.allowed}`
  );
  check(
    "informa cuántos segundos hay que esperar",
    fourth.retryAfterSeconds > 0 && fourth.retryAfterSeconds <= 60,
    `retryAfter=${fourth.retryAfterSeconds}s`
  );
  check("otra clave no hereda el bloqueo", limiter.hit("ip-b").allowed === true);

  clock += 61_000;
  check("al pasar la ventana se vuelve a permitir", limiter.hit("ip-a").allowed === true);

  // La fuga que tenía el limitador de vite.config.js: entradas que nunca se eliminan.
  const leaky = createRateLimiter({ windowMs: 1_000, max: 100, now });
  for (let i = 0; i < 600; i += 1) leaky.hit(`ip-${i}`);
  const beforeSweep = leaky.size;
  clock += 5_000;
  for (let i = 0; i < 600; i += 1) leaky.hit(`otra-${i}`);
  check(
    "purga las entradas caducadas en lugar de crecer sin tope",
    leaky.size < beforeSweep + 600,
    `antes=${beforeSweep} despues=${leaky.size} (sin purga serían ${beforeSweep + 600})`
  );

  // Un límite en 0 significa "desactivado", no "bloquear todo": es lo que se espera al
  // poner la variable de entorno a cero.
  const disabled = createRateLimiter({ windowMs: 1_000, max: 0, now });
  check("un límite de 0 desactiva el limitador", disabled.hit("x").allowed === true);

  // ── Cuota diaria ────────────────────────────────────────────────────────────
  clock = Date.UTC(2026, 7, 12, 23, 50, 0);
  const quota = createDailyQuota({ limit: 2, now });
  quota.hit("sesion-1");
  quota.hit("sesion-1");
  check("la cuota diaria bloquea al superar el tope", quota.hit("sesion-1").allowed === false);
  check(
    "consultar la cuota no la consume",
    quota.peek("sesion-2").used === 0 && quota.hit("sesion-2").allowed === true
  );

  // La renovación es a medianoche, no 24 h después de la primera consulta: quien empieza a
  // las 23:50 debe tener cuota nueva a los diez minutos.
  check(
    "la ventana termina en la medianoche UTC, no 24 h después",
    millisecondsUntilUtcMidnight(clock) === 10 * 60 * 1000,
    `faltan ${millisecondsUntilUtcMidnight(clock) / 60000} min`
  );
  clock += 11 * 60 * 1000;
  check("pasada la medianoche la cuota se renueva", quota.hit("sesion-1").allowed === true);

  // ── Presupuesto de tokens ───────────────────────────────────────────────────
  const budget = createTokenBudget({ dailyTokenCeiling: 500, now });
  check("con presupuesto disponible deja pasar", budget.hasBudget() === true);
  budget.record(300);
  check("sigue habiendo presupuesto tras un gasto parcial", budget.hasBudget() === true);
  budget.record(300);
  check("al superar el techo corta", budget.hasBudget() === false, `gastados=${budget.snapshot().spent}`);

  const unlimited = createTokenBudget({ dailyTokenCeiling: 0, now });
  unlimited.record(999_999);
  check("un techo de 0 desactiva el cortacircuitos", unlimited.hasBudget() === true);
}

// ══════════════════════════════════════════════════════════════════════════════
section("6. Identidad del cliente: la IP que no se puede falsificar");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { resolveClientIp, resolveSessionKey, normalizeIp } =
    await import("../server/clientIdentity.js");

  const withHeaders = (headers, remoteAddress = "130.211.0.1") => ({
    headers,
    socket: { remoteAddress }
  });

  // Detrás del balanceador de GCP la cabecera queda:
  //   <lo que envió el cliente>, <IP real>, <IP del balanceador>
  // Tomar la PRIMERA entrada —el error habitual— deja el limitador en un adorno.
  const spoofed = withHeaders({
    "x-forwarded-for": "1.2.3.4, 190.85.10.20, 130.211.0.1"
  });
  check(
    "una X-Forwarded-For falsificada por el cliente NO gana",
    resolveClientIp(spoofed, { trustedHops: 2 }) === "190.85.10.20",
    `resuelta=${resolveClientIp(spoofed, { trustedHops: 2 })} (la falsa era 1.2.3.4)`
  );

  check(
    "con un solo salto se toma la última entrada",
    resolveClientIp(withHeaders({ "x-forwarded-for": "190.85.10.20" }), { trustedHops: 1 }) ===
      "190.85.10.20"
  );

  check(
    "si la lista es más corta de lo esperado no se devuelve vacío",
    resolveClientIp(withHeaders({ "x-forwarded-for": "190.85.10.20" }), { trustedHops: 2 }) ===
      "190.85.10.20"
  );

  check(
    "sin la cabecera se cae a la dirección del socket",
    resolveClientIp(withHeaders({}, "10.1.2.3")) === "10.1.2.3"
  );

  check(
    "normaliza IPv4 mapeada en IPv6 y quita el puerto",
    normalizeIp("::ffff:190.85.10.20") === "190.85.10.20" &&
      normalizeIp("190.85.10.20:54321") === "190.85.10.20" &&
      normalizeIp("[2001:db8::1]:443") === "2001:db8::1",
    "sin esto, la misma máquina generaría una clave nueva por conexión"
  );

  // ── Clave de sesión ─────────────────────────────────────────────────────────
  const withConversation = (id) => ({ headers: { "x-conversation-id": id }, socket: {} });

  const good = resolveSessionKey(withConversation("7f3d9a2b-4c11-4e77-9f0a-1b2c3d4e5f60"), "1.1.1.1");
  check(
    "usa X-Conversation-ID como clave de sesión",
    good.source === "conversation" && good.key.startsWith("conv:")
  );

  const injected = resolveSessionKey(withConversation("a".repeat(500)), "1.1.1.1");
  check(
    "rechaza un identificador de sesión desmedido y cae a la IP",
    injected.source === "ip" && injected.key === "ip:1.1.1.1",
    "esa cadena se usa como clave de un Map y se escribe en logs"
  );

  const missing = resolveSessionKey({ headers: {}, socket: {} }, "9.9.9.9");
  check(
    "sin cabecera de conversación la cuota se aplica por IP",
    missing.source === "ip",
    "quitar la correlación no debe equivaler a quitar la cuota"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("7. Proxy de IA: acotado del gasto y degradación");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { createAiProxyHandler, createProxyConfig, buildGeminiRequest, REASONS } =
    await import("../server/aiProxy.js");
  const { Readable } = await import("node:stream");

  /** Petición falsa: `Readable` de verdad, para no depender del orden de suscripción. */
  const fakeRequest = ({ method = "POST", headers = {}, body = "" } = {}) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = "/api/ai/chat";
    req.headers = { "content-type": "application/json", ...headers };
    req.socket = { remoteAddress: "10.0.0.7" };
    return req;
  };

  const fakeResponse = () => {
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      headersSent: false,
      writeHead(status, headers) {
        res.statusCode = status;
        res.headers = headers || {};
        res.headersSent = true;
        return res;
      },
      end(chunk) {
        if (chunk) res.body += chunk;
      },
      get json() {
        try {
          return JSON.parse(res.body);
        } catch {
          return null;
        }
      }
    };
    return res;
  };

  /** Respuesta con forma de Gemini. */
  const geminiOk = (text, totalTokenCount) => async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount }
      });
    }
  });

  const validBody = (userText = "¿cuándo vence el predial?") =>
    JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: "eres el asistente de Floridablanca" }] },
      generationConfig: { maxOutputTokens: 200, temperature: 0.6 }
    });

  const baseConfig = {
    ...createProxyConfig({ ENVIRONMENT: "local" }),
    apiKey: "AIzaSyPRUEBA",
    ratePerMinute: 50,
    dailyQuotaPerSession: 2,
    dailyTokenCeiling: 400,
    allowedOrigins: [".floridablanca.gov.co"],
    isLocal: true
  };

  // ── Capa 1: el coste por petición está acotado ──────────────────────────────
  const abusive = buildGeminiRequest({
    contents: Array.from({ length: 80 }, (_, i) => ({
      role: "user",
      parts: [{ text: `turno ${i} `.repeat(500) }]
    })),
    systemInstruction: { parts: [{ text: "x".repeat(50_000) }] },
    generationConfig: { maxOutputTokens: 100_000, temperature: 9 }
  });

  check(
    "maxOutputTokens pedido por el cliente se acota al máximo del servidor",
    abusive.ok && abusive.request.generationConfig.maxOutputTokens === 200,
    `pedidos=100000 enviados=${abusive.request?.generationConfig?.maxOutputTokens}`
  );
  check(
    "la temperatura se acota a un rango válido",
    abusive.request.generationConfig.temperature === 1,
    `pedida=9 enviada=${abusive.request.generationConfig.temperature}`
  );
  check(
    "el historial se recorta al tope de turnos",
    abusive.request.contents.length <= 20,
    `enviados=${abusive.request.contents.length} de 80`
  );
  check(
    "el total de caracteres de entrada queda por debajo del techo",
    abusive.inputChars <= 24_000,
    `inputChars=${abusive.inputChars}`
  );
  check(
    "un rol inventado se normaliza y no llega a Google",
    buildGeminiRequest({
      contents: [{ role: "system", parts: [{ text: "hola" }] }]
    }).request.contents[0].role === "model",
    "la API solo acepta user y model"
  );
  check(
    "un cuerpo sin contents se rechaza",
    buildGeminiRequest({ systemInstruction: { parts: [{ text: "x" }] } }).ok === false
  );

  // ── Camino feliz y consumo de cuota ─────────────────────────────────────────
  {
    const proxy = createAiProxyHandler({
      config: baseConfig,
      fetchImpl: geminiOk("El predial vence el 30 de junio.", 160)
    });

    const res1 = fakeResponse();
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "sesion-feliz-0001" }, body: validBody() }), res1);

    check("responde 200 con el texto del modelo", res1.statusCode === 200 && res1.json?.text?.includes("30 de junio"));
    check(
      "reenvía usageMetadata para que el panel muestre tokens reales",
      res1.json?.usageMetadata?.totalTokenCount === 160
    );
    check(
      "informa el consumo de cuota de la sesión",
      res1.json?.quota?.used === 1 && res1.json?.quota?.limit === 2,
      JSON.stringify(res1.json?.quota)
    );

    // Segunda llamada: agota la cuota (límite 2).
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "sesion-feliz-0001" }, body: validBody() }), fakeResponse());

    const res3 = fakeResponse();
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "sesion-feliz-0001" }, body: validBody() }), res3);
    check(
      "al agotar la cuota responde 429 quota_exhausted",
      res3.statusCode === 429 && res3.json?.reason === REASONS.QUOTA_EXHAUSTED,
      `status=${res3.statusCode} reason=${res3.json?.reason}`
    );
    check("incluye Retry-After para que el cliente sepa cuándo reintentar", Boolean(res3.headers["Retry-After"]));

    const otherSession = fakeResponse();
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "sesion-distinta-002" }, body: validBody() }), otherSession);
    check("otra sesión conserva su propia cuota", otherSession.statusCode === 200);
  }

  // ── Cortacircuitos global ───────────────────────────────────────────────────
  {
    const proxy = createAiProxyHandler({
      config: { ...baseConfig, dailyQuotaPerSession: 100, dailyTokenCeiling: 300 },
      fetchImpl: geminiOk("respuesta", 200)
    });

    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "presupuesto-0001" }, body: validBody() }), fakeResponse());
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "presupuesto-0002" }, body: validBody() }), fakeResponse());

    const blocked = fakeResponse();
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "presupuesto-0003" }, body: validBody() }), blocked);
    check(
      "el techo diario de tokens corta a todo el servicio",
      blocked.statusCode === 429 && blocked.json?.reason === REASONS.QUOTA_EXHAUSTED,
      `gastados=${proxy.stats().spent} techo=${proxy.stats().ceiling}`
    );
    check(
      "el gasto acumulado es el que reporta la API, no una estimación",
      proxy.stats().spent === 400,
      `spent=${proxy.stats().spent} (2 llamadas x 200 tokens)`
    );
  }

  // ── Un fallo de Gemini no gasta la cuota del ciudadano ──────────────────────
  {
    const proxy = createAiProxyHandler({
      config: baseConfig,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } });
        }
      })
    });

    const res = fakeResponse();
    await proxy.handle(fakeRequest({ headers: { "x-conversation-id": "fallo-upstream-01" }, body: validBody() }), res);

    check(
      "un fallo de Gemini se traduce a 503 ai_unavailable",
      res.statusCode === 503 && res.json?.reason === REASONS.AI_UNAVAILABLE,
      `status=${res.statusCode}`
    );
    check(
      "el mensaje de error de Google NO llega al cliente",
      !res.body.includes("API key") && !res.body.includes("not valid"),
      "esos mensajes describen el estado de la credencial"
    );

    // La unidad de cuota se cobra solo si la llamada llegó a producir respuesta: una caída
    // del proveedor no debe gastarle la ración del día a nadie.
    const after = fakeResponse();
    const working = createAiProxyHandler({ config: baseConfig, fetchImpl: geminiOk("ok", 10) });
    await working.handle(fakeRequest({ headers: { "x-conversation-id": "fallo-upstream-01" }, body: validBody() }), after);
    check(
      "una caída del proveedor no consume cuota diaria",
      after.statusCode === 200 && after.json?.quota?.used === 1,
      `used=${after.json?.quota?.used} tras un fallo previo`
    );
  }

  // ── Sin credencial ──────────────────────────────────────────────────────────
  {
    const proxy = createAiProxyHandler({
      config: { ...baseConfig, apiKey: "" },
      fetchImpl: async () => {
        throw new Error("no debería llamarse");
      }
    });
    const res = fakeResponse();
    await proxy.handle(fakeRequest({ body: validBody() }), res);
    check(
      "sin GEMINI_API_KEY responde ai_unavailable en lugar de romperse",
      res.statusCode === 503 && res.json?.reason === REASONS.AI_UNAVAILABLE
    );
  }

  // ── Orígenes y CORS ─────────────────────────────────────────────────────────
  {
    const proxy = createAiProxyHandler({ config: baseConfig, fetchImpl: geminiOk("ok", 10) });

    const allowed = fakeResponse();
    await proxy.handle(
      fakeRequest({ method: "OPTIONS", headers: { origin: "https://tramites.floridablanca.gov.co" } }),
      allowed
    );
    check(
      "el preflight de un portal autorizado responde 204 con el origen reflejado",
      allowed.statusCode === 204 &&
        allowed.headers["Access-Control-Allow-Origin"] === "https://tramites.floridablanca.gov.co"
    );
    check(
      "declara las cabeceras de correlación que el widget envía",
      String(allowed.headers["Access-Control-Allow-Headers"]).includes("x-conversation-id"),
      "sin esto el navegador rechaza la petición real"
    );
    check(
      "nunca responde con comodín en el origen",
      allowed.headers["Access-Control-Allow-Origin"] !== "*",
      "el endpoint gasta dinero: quién lo invoca es control de gasto"
    );

    const rejected = fakeResponse();
    await proxy.handle(
      fakeRequest({ method: "OPTIONS", headers: { origin: "https://floridablanca.gov.co.dominio-falso.com" } }),
      rejected
    );
    check(
      "un dominio que solo IMITA el oficial se rechaza",
      rejected.statusCode === 403 && rejected.json?.reason === REASONS.FORBIDDEN_ORIGIN,
      "el comodín de sufijo compara el final exacto del hostname"
    );
  }

  // ── El texto del ciudadano no aparece en los logs ────────────────────────────
  {
    const { setupLogging } = await import("../server/logging.js");
    setupLogging({ logLevel: "DEBUG", serviceName: "prueba", serviceVersion: "t", environment: "local" });

    const captured = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1]() : true;
    };

    const SECRETO = "mi cedula es 1098765432 y vivo en la calle 20";
    try {
      const proxy = createAiProxyHandler({ config: baseConfig, fetchImpl: geminiOk("respuesta", 30) });
      await proxy.handle(
        fakeRequest({ headers: { "x-conversation-id": "logs-sesion-0001" }, body: validBody(SECRETO) }),
        fakeResponse()
      );
    } finally {
      process.stdout.write = originalWrite;
      setupLogging({ logLevel: "ERROR", serviceName: "prueba", serviceVersion: "t", environment: "local" });
    }

    const logs = captured.join("\n");
    check(
      "el texto del ciudadano no se registra en ningún log",
      logs !== "" && !logs.includes("1098765432") && !logs.includes("cedula"),
      `${captured.length} entradas emitidas, ninguna con el mensaje`
    );
    check(
      "sí se registra lo necesario para operar (tokens y cuota)",
      logs.includes("ai_reply_served") && logs.includes("total_tokens"),
      "hace falta poder auditar el gasto sin ver conversaciones"
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
section("8. Proxy de IA sobre HTTP real");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { aiProxy } = await import("../server/index.js");
  aiProxy.reset();

  const call = (extra = {}) =>
    fetch(`${BASE}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hola" }] }] })
    });

  const res = await call();
  const body = await res.json();
  check(
    "el endpoint está enrutado y responde JSON",
    res.status === 503 && body.reason === "ai_unavailable",
    `status=${res.status} reason=${body.reason} (sin GEMINI_API_KEY en las pruebas)`
  );
  check("no se cachea", res.headers.get("cache-control") === "no-store");

  const getRes = await fetch(`${BASE}/api/ai/chat`);
  check(
    "GET sobre el proxy responde 405 y anuncia los métodos válidos",
    getRes.status === 405 && String(getRes.headers.get("allow")).includes("POST"),
    `status=${getRes.status} allow=${getRes.headers.get("allow")}`
  );

  // El límite de tasa del entorno de pruebas es 5/min: se agota y debe cortar.
  aiProxy.reset();
  let limited = null;
  for (let i = 0; i < 8 && !limited; i += 1) {
    const r = await call();
    const b = await r.json();
    if (r.status === 429) limited = { status: r.status, body: b, retryAfter: r.headers.get("retry-after") };
  }
  check(
    "el límite por IP corta la ráfaga",
    limited?.body?.reason === "rate_limited",
    limited ? `status=${limited.status} retry-after=${limited.retryAfter}s` : "nunca cortó"
  );

  const tooLarge = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "8.8.8.8, 190.0.0.1, 130.211.0.1" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x".repeat(200_000) }] }] })
  });
  check(
    "un cuerpo desmedido se corta con 413",
    tooLarge.status === 413,
    `status=${tooLarge.status} (tope 128 KB)`
  );

  const badJson = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "8.8.4.4, 190.0.0.2, 130.211.0.1" },
    body: "{ esto no es json"
  });
  check("un JSON inválido responde 400", badJson.status === 400, `status=${badJson.status}`);

  aiProxy.reset();
}

// ── Cierre ─────────────────────────────────────────────────────────────────────
// `closeAllConnections` corta las conexiones keep-alive que deja `fetch`. Sin esto,
// `close()` espera a que expiren y el proceso termina de forma sucia.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

const fallos = results.filter((r) => !r.passed);
console.log(`\n\x1b[1m${"═".repeat(74)}\x1b[0m`);
console.log(
  `\x1b[1mSERVIDOR\x1b[0m  ${results.length - fallos.length}/${results.length} verificaciones superadas` +
    (fallos.length ? `, \x1b[31m${fallos.length} fallo(s)\x1b[0m` : ", \x1b[32mtodo en verde\x1b[0m")
);
console.log(`\x1b[1m${"═".repeat(74)}\x1b[0m\n`);

if (fallos.length) {
  for (const f of fallos) console.log(`  · [${f.section}] ${f.name}`);
  process.exit(1);
}
