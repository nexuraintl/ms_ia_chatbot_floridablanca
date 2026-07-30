import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  server: {
    cors: true
  },
  plugins: [
    react(),
    {
      name: 'log-writer-plugin',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.method === 'POST' && req.url === '/api/log-tokens') {
            let body = '';
            let bodyTooLarge = false;

            req.on('data', chunk => {
              body += chunk.toString();
              // Límite de seguridad: Máximo 10 KB por solicitud para prevenir DoS por agotamiento de memoria
              if (body.length > 10240) {
                bodyTooLarge = true;
                req.destroy();
              }
            });

            req.on('end', () => {
              if (bodyTooLarge) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                return;
              }

              try {
                const data = JSON.parse(body);
                // Saneamiento de CRLF / Log Injection
                const cleanPrompt = String(data.prompt || '')
                  .replace(/[\r\n\t]/g, ' ')
                  // eslint-disable-next-line no-control-regex
                  .replace(/[\u0000-\u001F]/g, '')
                  .substring(0, 300);

                const used = Math.max(0, parseInt(data.used, 10) || 0);
                const saved = Math.max(0, parseInt(data.saved, 10) || 0);

                const logMessage = `[${new Date().toISOString()}] Mensaje: "${cleanPrompt}" | Tokens Usados: ${used} | Tokens Ahorrados: ${saved}\n`;
                fs.appendFileSync(path.join(__dirname, 'token_usage.log'), logMessage);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
              }
            });
          } else {
            next();
          }
        });
      }
    }
  ],
})
