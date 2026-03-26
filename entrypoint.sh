#!/bin/sh
set -e

# Escribe el JSON de Google credentials desde la variable de entorno
if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  echo "$GOOGLE_CREDENTIALS_JSON" > /app/credentials.json
  export GOOGLE_CREDENTIALS_PATH=/app/credentials.json
fi

exec node index.js
