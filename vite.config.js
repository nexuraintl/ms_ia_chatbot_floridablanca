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
            req.on('data', chunk => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const data = JSON.parse(body);
                const logMessage = `[${new Date().toLocaleString()}] Mensaje: "${data.prompt}" | Tokens Usados: ${data.used} | Tokens Ahorrados: ${data.saved}\n`;
                fs.appendFileSync(path.join(__dirname, 'token_usage.log'), logMessage);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error al escribir log: ' + e.message);
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
