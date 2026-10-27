FROM node:22-alpine

WORKDIR /app

# Chromium del sistema para whatsapp-web.js/Puppeteer.
# En Alpine (musl) NO funciona el Chromium que descarga Puppeteer, así que se usa el del sistema.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
# Normaliza la ruta del binario (según versión de Alpine puede ser chromium o chromium-browser).
RUN if [ ! -e /usr/bin/chromium-browser ] && [ -e /usr/bin/chromium ]; then \
      ln -s /usr/bin/chromium /usr/bin/chromium-browser; \
    fi
# Evita que `npm ci` intente descargar Chromium y apunta Puppeteer al binario del sistema.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Directorio persistente de la sesión de WhatsApp (LocalAuth). Montar como VOLUMEN
# en runtime para que la sesión sobreviva a reinicios del contenedor.
RUN mkdir -p /data/wwebjs_auth

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
