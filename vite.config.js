import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Tamaño máximo del cuerpo aceptado, para evitar agotamiento de memoria. */
const MAX_BODY_BYTES = 10 * 1024

/** Tamaño máximo del archivo de log antes de rotarlo. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Ventana y tope del limitador de tasa por IP. */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60

/**
 * Plugin de desarrollo que registra el consumo de tokens en `token_usage.log`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDURECIMIENTO RESPECTO A LA VERSIÓN ANTERIOR
 *
 * El endpoint no comprobaba NADA sobre el origen de la petición, y el servidor tenía
 * `cors: true` (acepta cualquier origen). Combinado, eso significaba que cualquier
 * página web abierta en el navegador mientras corría `npm run dev` podía hacer
 * `fetch("http://localhost:5173/api/log-tokens", {method:"POST", …})` y escribir
 * líneas arbitrarias en el archivo de log del desarrollador, sin límite de cantidad,
 * hasta llenar el disco.
 *
 * Se añade:
 *   · Validación de cabecera `Origin`: solo se aceptan orígenes locales.
 *   · Limitador de tasa por IP.
 *   · Rotación del archivo al superar 5 MB.
 *   · Escritura asíncrona: `appendFileSync` bloqueaba el hilo del servidor de desarrollo.
 *
 * El saneamiento de CRLF que ya existía se mantiene: era correcto y la suite de
 * seguridad lo verifica.
 *
 * IMPORTANTE: este endpoint solo existe en el servidor de desarrollo (`configureServer`
 * no se ejecuta en un build de producción). Si alguna vez se necesita telemetría en
 * producción, debe implementarse en el backend con autenticación y sin datos personales.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const tokenLogPlugin = () => {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const rateLimiter = new Map()

  const isRateLimited = (ip) => {
    const now = Date.now()
    const entry = rateLimiter.get(ip)

    if (!entry || now > entry.resetAt) {
      rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
      return false
    }

    entry.count += 1
    return entry.count > RATE_LIMIT_MAX_REQUESTS
  }

  /** Solo se acepta telemetría desde el propio entorno de desarrollo. */
  const isLocalOrigin = (origin) => {
    if (!origin) return true // petición del mismo origen: el navegador omite Origin
    try {
      const { hostname } = new URL(origin)
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    } catch {
      return false
    }
  }

  const appendLogLine = (line) => {
    const logPath = path.join(__dirname, 'token_usage.log')
    try {
      // Rotar si el archivo creció demasiado.
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`)
      }
    } catch {
      /* si la rotación falla, se sigue escribiendo */
    }
    // Asíncrono: no bloquear el hilo del servidor de desarrollo.
    fs.appendFile(logPath, line, () => {})
  }

  return {
    name: 'token-usage-log-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || req.url !== '/api/log-tokens') {
          return next()
        }

        const send = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }

        if (!isLocalOrigin(req.headers.origin)) {
          return send(403, { error: 'Forbidden origin' })
        }

        const ip = req.socket?.remoteAddress || 'unknown'
        if (isRateLimited(ip)) {
          return send(429, { error: 'Too Many Requests' })
        }

        let body = ''
        let bodyTooLarge = false

        req.on('data', (chunk) => {
          body += chunk.toString()
          if (body.length > MAX_BODY_BYTES) {
            bodyTooLarge = true
            req.destroy()
          }
        })

        req.on('end', () => {
          if (bodyTooLarge) {
            return send(413, { error: 'Payload Too Large' })
          }

          try {
            const data = JSON.parse(body)

            // Saneamiento de CRLF / inyección en logs.
            const cleanPrompt = String(data.prompt || '')
              .replace(/[\r\n\t]/g, ' ')
              // eslint-disable-next-line no-control-regex
              .replace(/[\u0000-\u001f]/g, '')
              .substring(0, 300)

            const used = Math.max(0, parseInt(data.used, 10) || 0)
            const saved = Math.max(0, parseInt(data.saved, 10) || 0)

            appendLogLine(
              `[${new Date().toISOString()}] Mensaje: "${cleanPrompt}" | Tokens Usados: ${used} | Tokens Ahorrados: ${saved}\n`
            )

            send(200, { success: true })
          } catch {
            send(400, { error: 'Invalid JSON payload' })
          }
        })
      })
    }
  }
}

/**
 * Backend del chatbot durante el desarrollo (`npm start` en otra terminal).
 *
 * El servidor de desarrollo de Vite no tiene los proxies: los RPA exigen un identity token
 * y la clave de Gemini vive en el servidor. Así que `/rpa/*` y `/api/ai/*` se reenvían al
 * backend real. Sin esto, en `npm run dev` los trámites responden con el index.html.
 */
const DEV_BACKEND = process.env.DEV_BACKEND_ORIGIN || 'http://localhost:8080'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // Antes era `cors: true`, que responde con `Access-Control-Allow-Origin: *` y
    // permite a cualquier sitio web leer las respuestas del servidor de desarrollo.
    // El widget se prueba embebido en portales locales, así que basta con permitir
    // orígenes locales de forma explícita.
    cors: {
      origin: [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
      credentials: false
    },
    proxy: {
      // Solo `/api/ai`, no todo `/api`: `/api/log-tokens` lo atiende el plugin de abajo.
      '/api/ai': { target: DEV_BACKEND, changeOrigin: false },
      '/rpa': { target: DEV_BACKEND, changeOrigin: false }
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        embed: path.resolve(__dirname, 'src/embed.jsx')
      },
      output: {
        /**
         * El punto de entrada del widget embebido necesita una URL ESTABLE: el portal que
         * lo incrusta lleva ese `<script src>` escrito en su plantilla, y con un nombre con
         * hash cada despliegue lo dejaría apuntando a un archivo que ya no existe.
         *
         * El resto de los assets conserva el hash, que es lo que permite cachearlos para
         * siempre. `assets/embed.js` se sirve con `no-cache` justamente por no llevarlo.
         */
        entryFileNames: (chunk) =>
          chunk.name === 'embed' ? 'assets/embed.js' : 'assets/[name]-[hash].js'
      }
    }
  },
  plugins: [react(), tokenLogPlugin()]
})
