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
