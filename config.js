require('dotenv').config();

// ── Configuración multi-programa ────────────────────
// Cada programa tiene su propio servidor Discord, productos Hotmart,
// roles de verificación, Google Sheet y webhook de n8n.
// Un solo bot, un solo token, múltiples servidores.

const PROGRAMS = {
  programaA: {
    name: 'Inversionistas Conscientes',
    guildId: process.env.GUILD_ID_A,
    inviteChannelId: process.env.INVITE_CHANNEL_ID_A,
    products: [
      process.env.HOTMART_PRODUCT_A1,
      process.env.HOTMART_PRODUCT_A2,
    ].filter(Boolean),
    roles: ['Activo', '2026-2', 'Iniciador de Mercados'],
    // Columnas del Sheet donde están los roles (E=Estado, F=Generación, G=Nivel)
    // Cada entrada mapea 1:1 con el array roles[] para la escritura post-verificación
    roleColumns: [
      { index: 4, letter: 'E' },  // Estado
      { index: 5, letter: 'F' },  // Generación
      { index: 6, letter: 'G' },  // Nivel
    ],
    sheetId: process.env.SHEET_ID_A,
    sheetRange: 'miembros_discord!A2:G',
    bajasSheetName: 'Bajas',
    // Hoja "Compras de Hotmart" (llenada por n8n): A:nombre B:correo C:telefono
    // D:codigo hp E:producto F:estado G:discord id  H:estado_tutorial (idempotencia del bot)
    comprasSheetId: process.env.COMPRAS_SHEET_ID_A || process.env.SHEET_ID_A,
    comprasSheetRange: process.env.COMPRAS_SHEET_RANGE_A || 'Compras de Hotmart!A2:H',
    // Fallback del tutorial: si WhatsApp falla, el bot hace POST aquí y n8n/Chatwoot envía.
    tutorialFallbackWebhook: process.env.N8N_TUTORIAL_WEBHOOK_A,
    webhookN8n: process.env.N8N_WEBHOOK_A,
    appscriptUrl: process.env.APPSCRIPT_URL_A,
    appscriptToken: process.env.APPSCRIPT_TOKEN_A,
    senderName: 'Nico Barrera Academy',
    brandColor: '#D4AF37',
    email: {
      title: '&#161;Bienvenido al Proyecto Inversionista Consciente! &#128640;',
      greeting: 'Hola, Inversor &#128075;',
      body: 'Tu compra es el primer paso para formar parte de una comunidad de personas reales, con objetivos reales, dispuestas a crecer, aprender y construir un futuro con propósito.',
      cta: '&#9654; &Uacute;NETE A LA COMUNIDAD EN DISCORD',
      closing: '&#161;Estamos felices de tenerte con nosotros!\nEsto reci&eacute;n empieza, y lo mejor est&aacute; por venir.',
      teamName: 'Equipo Nico Barrera',
    },
  },
  programaB: {
    name: 'Creeser',
    guildId: process.env.GUILD_ID_B,
    inviteChannelId: process.env.INVITE_CHANNEL_ID_B,
    products: [
      process.env.HOTMART_PRODUCT_B1,
      process.env.HOTMART_PRODUCT_B2,
    ].filter(Boolean),
    roles: ['Activo'],
    // Columna E = Estado (única columna de roles para este programa)
    roleColumns: [
      { index: 4, letter: 'E' },  // Estado
    ],
    sheetId: process.env.SHEET_ID_B,
    sheetRange: 'miembros_discord!A2:E',
    bajasSheetName: 'Bajas',
    // Hoja "Compras de Hotmart" (llenada por n8n): A:nombre B:correo C:telefono ... H:estado_tutorial
    comprasSheetId: process.env.COMPRAS_SHEET_ID_B || process.env.SHEET_ID_B,
    comprasSheetRange: process.env.COMPRAS_SHEET_RANGE_B || 'Compras de Hotmart!A2:H',
    // Fallback del tutorial: si WhatsApp falla, el bot hace POST aquí y n8n/Chatwoot envía.
    tutorialFallbackWebhook: process.env.N8N_TUTORIAL_WEBHOOK_B,
    webhookN8n: process.env.N8N_WEBHOOK_B,
    appscriptUrl: process.env.APPSCRIPT_URL_B,
    appscriptToken: process.env.APPSCRIPT_TOKEN_B,
    senderName: 'Creeser',
    brandColor: '#49b3ff',
    email: {
      title: '&#161;Bienvenido a CreeSer Experience! &#10024;',
      greeting: 'Hola, Creador &#128075;',
      body: 'Tu compra es el primer paso para formar parte de una comunidad enfocada en tu crecimiento personal y en convertirte en la mejor versión de ti mismo.',
      cta: '&#9654; &Uacute;NETE A LA COMUNIDAD EN DISCORD',
      closing: '&#161;Estamos felices de tenerte con nosotros!\nEsto reci&eacute;n empieza, y lo mejor est&aacute; por venir.',
      teamName: 'Equipo CreeSer',
    },
  },
};

// ── Helpers ──────────────────────────────────────────

function getProgramByGuildId(guildId) {
  return Object.values(PROGRAMS).find(p => p.guildId === guildId) || null;
}

function getProgramByProductId(productId) {
  const id = String(productId);
  return Object.values(PROGRAMS).find(p => p.products.includes(id)) || null;
}

// ── Config global ───────────────────────────────────

const config = {
  token: process.env.DISCORD_TOKEN,
  googleCredentialsPath: process.env.GOOGLE_CREDENTIALS_PATH,
  hottok: process.env.HOTTOK,
  port: parseInt(process.env.PORT, 10) || 3000,
  // ── WhatsApp (whatsapp-web.js) ──
  whatsapp: {
    // Directorio de sesión de LocalAuth. En Docker montar como VOLUMEN para
    // que la sesión sobreviva a reinicios (si no, re-escaneo de QR cada vez).
    sessionPath: process.env.WA_SESSION_PATH || '/data/wwebjs_auth',
    // Token para proteger el endpoint GET /wa/qr.
    qrToken: process.env.WA_QR_TOKEN,
    // Ruta al Chromium del sistema (Docker/Alpine). Vacío en local → usa el de Puppeteer.
    chromiumPath: process.env.WA_CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null,
    // Código de país por defecto para números sin prefijo (Colombia = 57).
    defaultCountryCode: process.env.WA_DEFAULT_COUNTRY_CODE || '57',
  },
  // Mensaje único global del tutorial enviado por WhatsApp.
  tutorialMessage:
    process.env.TUTORIAL_MESSAGE ||
    `Hola, Inversionista 👋

¡Bienvenido a la comunidad! Estamos emocionados de que des este paso para llevar tu conciencia y tus finanzas al siguiente nivel. 🚀

Recuerda que tu generación es 2026-3. 📚

Para arrancar con toda, las dos plataformas principales que manejamos son Hotmart y Discord. A continuación, te dejamos unos breves tutoriales para que los revises, puedas acceder a las plataformas y continuar con todo el proceso.

📚 Paso 1: Tu Plataforma (Hotmart)

Aquí están tus clases. Mira este video rápido de 1 minuto para saber por dónde empezar a estudiar hoy:

👉 https://videos.nicobarreraacademy.com/Hotmart.mp4

🤝 Paso 2: La Comunidad (Discord)

¡Aquí ocurre la magia! Resuelve dudas y conecta con otros Inversionistas Conscientes. Mira cómo unirte:

👉 https://videos.nicobarreraacademy.com/Discord.mp4

¡No pierdas tiempo y empieza desde hoy! 🔥

¡Nos vemos adentro! 💪🚀`,
  PROGRAMS,
  getProgramByGuildId,
  getProgramByProductId,
};

module.exports = config;
