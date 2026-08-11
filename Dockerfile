# syntax=docker/dockerfile:1
#
# Imagen del widget de chatbot para Cloud Run (GOB-GCP-STD-01).
#
# Cumple los requisitos del estándar:
#   · Build multi-stage (builder + imagen final mínima)
#   · Usuario no-root en la imagen final
#   · Respeta la variable $PORT de Cloud Run
#   · Sin dependencias de desarrollo en la imagen final
#
# Nota sobre las variables VITE_*: Vite las sustituye por su valor LITERAL durante el
# build, así que se inyectan como ARG en la etapa de compilación y quedan incrustadas
# en el bundle. Por eso aquí SOLO pueden ir valores públicos (nombre del servicio,
# versión, ambiente, URLs de microservicios). NUNCA una clave de API: quedaría
# publicada en un archivo estático descargable. Ver SECURITY.md, hallazgo H-01.

# ─────────────────────────────────────────────────────────────────────────────
# Etapa 1: compilación del bundle
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Variables de compilación. Cloud Build las pasa con --build-arg.
ARG VITE_SERVICE_NAME=ia-chatbot-floridablanca
ARG VITE_SERVICE_VERSION=0.0.0
ARG VITE_ENVIRONMENT=qam
ARG VITE_GOOGLE_CLOUD_PROJECT=""
ARG VITE_RPA_PREDIAL_API_URL=""
ARG VITE_RPA_PQRSD_API_URL=""
ARG VITE_CONVERSATION_API_URL=""
ARG VITE_PERSISTENCE_MODE=off

ENV VITE_SERVICE_NAME=$VITE_SERVICE_NAME \
    VITE_SERVICE_VERSION=$VITE_SERVICE_VERSION \
    VITE_ENVIRONMENT=$VITE_ENVIRONMENT \
    VITE_GOOGLE_CLOUD_PROJECT=$VITE_GOOGLE_CLOUD_PROJECT \
    VITE_RPA_PREDIAL_API_URL=$VITE_RPA_PREDIAL_API_URL \
    VITE_RPA_PQRSD_API_URL=$VITE_RPA_PQRSD_API_URL \
    VITE_CONVERSATION_API_URL=$VITE_CONVERSATION_API_URL \
    VITE_PERSISTENCE_MODE=$VITE_PERSISTENCE_MODE

# Copiar solo los manifiestos primero: así la capa de dependencias se reutiliza
# mientras package-lock.json no cambie, aunque cambie el código.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Etapa 2: imagen final
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# `dumb-init` reenvía correctamente las señales: sin él, el proceso de Node corre como
# PID 1 y puede ignorar el SIGTERM que Cloud Run envía al retirar una instancia,
# cortando peticiones en curso.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Solo el resultado del build y el servidor. Ni node_modules, ni código fuente, ni
# dependencias de desarrollo: el servidor usa únicamente módulos nativos de Node.
COPY --from=builder --chown=node:node /build/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node package.json ./

# Usuario no-root. Las imágenes oficiales de Node ya traen el usuario `node`
# (uid 1000), así que no hace falta crear uno.
USER node

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# Comprobación de salud contra el endpoint que exige el estándar.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
