// ── Servicio aislado de WhatsApp (whatsapp-web.js) ──────────────────────────
// Envía el tutorial post-compra desde el WhatsApp propio. Está diseñado para
// DEGRADAR CON GRACIA: si la dependencia no está instalada, si Chromium no
// arranca o si la sesión se cae, `isWhatsAppReady()` devuelve false y el resto
// del bot (invites.js) cae automáticamente al fallback de n8n/Chatwoot.
// Nunca lanza desde setup(): un fallo aquí no puede tumbar el proceso.

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

// Cargas tolerantes: si las deps aún no están instaladas, el módulo se
// deshabilita en vez de romper el arranque del bot.
let Client, LocalAuth;
try {
  ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (_) {
  Client = null;
  LocalAuth = null;
}

let qrcodeTerminal = null;
try {
  qrcodeTerminal = require('qrcode-terminal');
} catch (_) {
  qrcodeTerminal = null;
}

const REINIT_DELAY_MS = 30_000; // backoff tras desconexión/fallo

// ── Estado interno ──
let client = null;
let isReady = false;
let lastQr = null;
let initializing = false;
let reinitTimer = null;

function isWhatsAppReady() {
  return isReady && client != null;
}

// Estado para el endpoint web GET /wa/qr
function getQrState() {
  return { ready: isReady, qr: isReady ? null : lastQr };
}

// Borra los locks de Chromium que quedan cuando el contenedor se mata sin cierre
// limpio (típico en cada Deploy). Sin esto, con sesión en volumen persistente el
// siguiente arranque falla con "profile appears to be in use by another Chromium".
function clearChromiumLocks(sessionPath) {
  if (!sessionPath) return;
  const dirs = [sessionPath, path.join(sessionPath, 'session')];
  const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const dir of dirs) {
    for (const f of files) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch (_) {
        /* best-effort: si no existe o no se puede borrar, seguimos */
      }
    }
  }
}

function buildClient(config) {
  const wa = config.whatsapp || {};
  const puppeteerOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  // Solo fijar executablePath si viene configurado (Docker/Alpine).
  // En local (Windows/Mac) se deja vacío para usar el Chromium de Puppeteer.
  if (wa.chromiumPath) puppeteerOpts.executablePath = wa.chromiumPath;

  return new Client({
    authStrategy: new LocalAuth({ dataPath: wa.sessionPath || './.wwebjs_auth' }),
    puppeteer: puppeteerOpts,
  });
}

function attachHandlers(config) {
  client.on('qr', (qr) => {
    lastQr = qr;
    isReady = false;
    logger.warn({
      msg: 'WhatsApp QR generado — escanea con el telefono (o abre GET /wa/qr?token=...)',
    });
    if (qrcodeTerminal) {
      try {
        qrcodeTerminal.generate(qr, { small: true });
      } catch (_) {
        /* render del QR ASCII es best-effort */
      }
    }
  });

  client.on('authenticated', () => {
    logger.info({ msg: 'WhatsApp autenticado' });
  });

  client.on('auth_failure', (m) => {
    isReady = false;
    logger.error({ msg: 'WhatsApp auth_failure', detail: String(m) });
  });

  client.on('ready', () => {
    isReady = true;
    lastQr = null;
    logger.info({ msg: 'WhatsApp listo (ready)' });
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    logger.warn({ msg: 'WhatsApp desconectado', reason: String(reason) });
    scheduleReinit(config);
  });
}

async function initialize(config) {
  if (initializing) return;
  initializing = true;
  try {
    const wa = config.whatsapp || {};
    clearChromiumLocks(wa.sessionPath || './.wwebjs_auth');
    client = buildClient(config);
    attachHandlers(config);
    await client.initialize();
  } catch (err) {
    isReady = false;
    logger.error({
      msg: 'Fallo inicializando WhatsApp; el bot sigue y todo cae al fallback n8n',
      err: err.message,
    });
    scheduleReinit(config);
  } finally {
    initializing = false;
  }
}

function scheduleReinit(config) {
  if (reinitTimer) return; // ya hay un reintento programado
  reinitTimer = setTimeout(async () => {
    reinitTimer = null;
    logger.info({ msg: 'Reintentando inicializar WhatsApp' });
    if (client) {
      try {
        await client.destroy();
      } catch (_) {
        /* destroy best-effort */
      }
    }
    client = null;
    initialize(config);
  }, REINIT_DELAY_MS);
  if (reinitTimer.unref) reinitTimer.unref();
}

// Normaliza a solo dígitos y antepone el código de país si parece un número local.
function normalizePhone(rawPhone, defaultCountryCode) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2); // prefijo internacional 00
  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  if (cc && !digits.startsWith(cc) && digits.length <= 10) {
    digits = cc + digits;
  }
  return digits;
}

// Envía el tutorial. LANZA ante cualquier problema (no listo, número inválido,
// número no registrado en WhatsApp, timeout, sesión caída) para que el caller
// active el fallback.
async function sendTutorial(rawPhone, message, opts = {}) {
  if (!isWhatsAppReady()) throw new Error('whatsapp_no_listo');
  if (!message) throw new Error('mensaje_tutorial_vacio');

  const digits = normalizePhone(rawPhone, opts.countryCode);
  if (!digits) throw new Error('telefono_invalido');

  const numberId = await client.getNumberId(digits);
  if (!numberId) throw new Error(`numero_no_registrado_en_whatsapp:${digits}`);

  await client.sendMessage(numberId._serialized, message);
  return { to: numberId._serialized };
}

// Llamado desde index.js antes del login del bot. No bloquea ni lanza.
function setup(_discordClient, config) {
  if (!Client || !LocalAuth) {
    logger.error({
      msg: 'whatsapp-web.js no instalado; envio por WhatsApp deshabilitado (se usara fallback n8n)',
    });
    return;
  }
  // Init en segundo plano: no bloquea el login del bot.
  initialize(config).catch((e) =>
    logger.error({ msg: 'init WhatsApp rechazado', err: String(e) })
  );
  logger.info('Modulo whatsapp cargado');
}

module.exports = { setup, isWhatsAppReady, sendTutorial, getQrState };
