const express = require('express');
const { fetch } = require('undici');
const Bottleneck = require('bottleneck');
const { logger } = require('../utils/logger');
const { getRows, updateRow } = require('../utils/sheets');
const { isWhatsAppReady, sendTutorial, getQrState } = require('./whatsapp');

// qrcode es opcional: si no está instalado, el endpoint /wa/qr degrada a mostrar
// el string del QR en texto (siempre queda el QR ASCII en los logs del contenedor).
let QRCode = null;
try {
  QRCode = require('qrcode');
} catch (_) {
  QRCode = null;
}

const INVITE_TTL_MS = 1000 * 60 * 30; // 30 min
const FETCH_TIMEOUT_MS = 1000 * 15;   // 15s
const CACHE_CLEANUP_MS = 1000 * 60 * 10;

// Anti-duplicados
const invitesByTxn = new Map();
const invitesByEmail = new Map();

// Rate limiter
const limiter = new Bottleneck({ minTime: 200 });

function getCachedInvite(txnId, email, programName) {
  const now = Date.now();
  if (txnId && invitesByTxn.has(txnId)) {
    const v = invitesByTxn.get(txnId);
    if (now - v.ts < INVITE_TTL_MS) return v.inviteUrl;
  }
  const emailKey = email && programName ? `${email}::${programName}` : null;
  if (emailKey && invitesByEmail.has(emailKey)) {
    const v = invitesByEmail.get(emailKey);
    if (now - v.ts < INVITE_TTL_MS) return v.inviteUrl;
  }
  return null;
}

function cacheInvite(txnId, email, inviteUrl, programName) {
  const record = { inviteUrl, ts: Date.now() };
  if (txnId) invitesByTxn.set(txnId, record);
  const emailKey = email && programName ? `${email}::${programName}` : null;
  if (emailKey) invitesByEmail.set(emailKey, record);
}

function cleanupInviteCache() {
  const now = Date.now();
  for (const [k, v] of invitesByTxn) {
    if (now - v.ts >= INVITE_TTL_MS) invitesByTxn.delete(k);
  }
  for (const [k, v] of invitesByEmail) {
    if (now - v.ts >= INVITE_TTL_MS) invitesByEmail.delete(k);
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const opts = { ...options, signal: controller.signal };
  return fetch(url, opts).finally(() => clearTimeout(id));
}

async function createOneUseInvite(botToken, channelId) {
  const url = `https://discord.com/api/v10/channels/${channelId}/invites`;
  const body = { max_uses: 1, max_age: 604800, unique: true, temporary: false }; // 604800s = 7 días

  const maxRetries = 5;
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after || 1) * 1000);
      logger.warn({ msg: 'Rate limit Discord, reintentando', wait_ms: wait, attempt });
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Discord invite error: ${res.status} ${txt}`);
    }

    const invite = await res.json();
    return `https://discord.gg/${invite.code}`;
  }
  throw new Error('Discord invite error: rate limit persistente');
}

function getProductIdFrom(payload = {}, validProducts) {
  const candidates = [
    payload?.product?.id,
    payload?.data?.product?.id,
    payload?.data?.item?.product?.id,
    payload?.data?.purchase?.product?.id,
    payload?.item?.product?.id,
    payload?.items?.[0]?.product?.id,
    payload?.offer?.product?.id,
    payload?.data?.offer?.product?.id,
    payload?.data?.items?.[0]?.product?.id,
  ].filter((x) => x != null).map(String);

  const preferred = candidates.find((id) => validProducts.has(id));
  if (preferred) return preferred;
  if (candidates[0]) return String(candidates[0]).trim() || null;

  const ids = [];
  const push = (v) => { if (v !== undefined && v !== null && v !== 0) ids.push(String(v)); };

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.product && typeof node.product === 'object') push(node.product.id);
    if (node.items && Array.isArray(node.items)) node.items.forEach(it => push(it?.product?.id));
    Object.keys(node).forEach(k => walk(node[k]));
  }

  walk(payload);
  const found = ids.find(id => validProducts.has(id));
  return found || ids[0] || null;
}

function buildInviteEmailHtml(inviteUrl, programa) {
  const brandColor = programa.brandColor || '#D4AF37';
  const e = programa.email || {};
  const title = e.title || `¡Bienvenido a ${programa.name}!`;
  const greeting = e.greeting || 'Hola 👋';
  const body = e.body || 'Gracias por tu compra. Únete a nuestra comunidad privada en Discord.';
  const cta = e.cta || '👉 ÚNETE A LA COMUNIDAD EN DISCORD';
  const closing = (e.closing || '¡Estamos felices de tenerte con nosotros!').replace(/\n/g, '<br>');
  const teamName = e.teamName || programa.senderName || 'El Equipo';

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body, table, td { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
    a { text-decoration: none; }
  </style>
</head>
<body style="margin:0;padding:0;background:#060b16;color:#e6f5ff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:40px auto;">
    <tr><td style="background:#0d1422;border-radius:16px;padding:48px 36px;text-align:center;">

      <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:700;line-height:1.3;color:#ffffff;">${title}</h1>

      <p style="margin:0 0 24px 0;font-size:15px;color:#c0c8d4;">${greeting}</p>

      <p style="margin:0 0 32px 0;font-size:15px;line-height:1.6;color:#c0c8d4;">${body}</p>

      <a href="${inviteUrl}" style="display:inline-block;padding:16px 32px;border-radius:10px;background:${brandColor};color:#00101e;font-size:15px;font-weight:800;letter-spacing:.02em;">
        ${cta}
      </a>

      <p style="margin:20px 0 0 0;font-size:13px;color:#8a94a3;">
        Este enlace es <b style="color:#e6f5ff;">de un solo uso</b> y expira en <b style="color:#e6f5ff;">7 días</b>.
      </p>

      <p style="margin:8px 0 0 0;font-size:12px;color:#5e6775;">
        Si el bot&oacute;n no funciona, copia y pega este enlace:
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;">
        <a href="${inviteUrl}" style="color:${brandColor};">${inviteUrl}</a>
      </p>

      <hr style="border:none;border-top:1px solid #1e2636;margin:32px 0;">

      <p style="margin:0 0 6px 0;font-size:14px;line-height:1.5;color:#c0c8d4;">${closing}</p>

      <p style="margin:12px 0 0 0;font-size:14px;color:#8a94a3;">
        Con entusiasmo,<br><b style="color:#e6f5ff;">${teamName}</b>
      </p>

    </td></tr>
  </table>
</body>
</html>`;
}

async function sendInviteEmailGAS(toEmail, inviteUrl, programa) {
  if (!programa.appscriptUrl || !programa.appscriptToken) {
    throw new Error('Apps Script no configurado para ' + programa.name);
  }
  const subject = `Bienvenido a ${programa.name}! Acceso a la comunidad`;
  const html = buildInviteEmailHtml(inviteUrl, programa);

  const res = await fetchWithTimeout(programa.appscriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: programa.appscriptToken,
      to: toEmail,
      subject,
      html,
      senderName: programa.senderName,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GAS send error: ${res.status} ${txt}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`GAS responded not ok: ${JSON.stringify(json)}`);
  return 'GAS_OK';
}

async function processApprovedPurchase(payload, programa, botToken) {
  const buyerEmail =
    payload?.buyer?.email ||
    payload?.data?.buyer?.email ||
    payload?.purchase?.buyer?.email ||
    payload?.data?.purchase?.buyer?.email ||
    'desconocido@correo';

  const txnId =
    payload?.data?.purchase?.transaction ||
    payload?.purchase?.transaction ||
    payload?.transaction ||
    'sin_txn';

  const cached = getCachedInvite(txnId, buyerEmail, programa.name);
  if (cached) {
    logger.info({ msg: 'Reuso de invitacion en cache', inviteUrl: cached, email: buyerEmail, programa: programa.name });
    await sendInviteEmailGAS(buyerEmail, cached, programa);
    return true;
  }

  if (!buyerEmail || buyerEmail === 'desconocido@correo') {
    logger.warn({ msg: 'Email ausente en payload', txnId });
    return false;
  }

  const inviteUrl = await createOneUseInvite(botToken, programa.inviteChannelId);
  logger.info({ msg: 'Invitacion creada', inviteUrl, programa: programa.name });
  cacheInvite(txnId, buyerEmail, inviteUrl, programa.name);

  await sendInviteEmailGAS(buyerEmail, inviteUrl, programa);
  logger.info({ msg: 'Correo enviado', email: buyerEmail, programa: programa.name });
  return true;
}

// ── Envío del tutorial por WhatsApp con fallback a n8n/Chatwoot ──────────────
// Columnas de "Compras de Hotmart" (rango A2:H):
//   A=0 nombre  B=1 correo  C=2 telefono  D=3 codigo hp  E=4 producto
//   F=5 estado  G=6 discord id  H=7 estado_tutorial (idempotencia del bot)
const COMPRAS_COL = { email: 1, phone: 2, statusLetter: 'H', statusIdx: 7 };

// Extrae correo y transacción del payload de Hotmart (mismos caminos que
// processApprovedPurchase, pero devolviendo email=null si es desconocido).
function getBuyerInfo(payload = {}) {
  const rawEmail =
    payload?.buyer?.email ||
    payload?.data?.buyer?.email ||
    payload?.purchase?.buyer?.email ||
    payload?.data?.purchase?.buyer?.email ||
    null;
  const email =
    rawEmail && rawEmail !== 'desconocido@correo' ? String(rawEmail).trim() : null;
  const txnId =
    payload?.data?.purchase?.transaction ||
    payload?.purchase?.transaction ||
    payload?.transaction ||
    'sin_txn';
  return { email, txnId };
}

// Busca la fila del cliente por correo en "Compras de Hotmart".
// Reintento acotado para tolerar la carrera con la escritura de n8n en el Sheet.
async function lookupPhoneByEmail(config, programa, email, { retries = 3, delayMs = 3000 } = {}) {
  const target = String(email).trim().toLowerCase();
  for (let attempt = 1; attempt <= retries; attempt++) {
    let rows = [];
    try {
      rows = await getRows(config.googleCredentialsPath, programa.comprasSheetId, programa.comprasSheetRange);
    } catch (err) {
      logger.warn({ msg: 'Error leyendo "Compras de Hotmart"', err: err.message, attempt });
    }
    const row = rows.find((r) => String(r[COMPRAS_COL.email] || '').trim().toLowerCase() === target);
    if (row) {
      return {
        rowFound: true,
        storedEmail: String(row[COMPRAS_COL.email] || '').trim(),
        phone: String(row[COMPRAS_COL.phone] || '').trim(),
        alreadySent: !!String(row[COMPRAS_COL.statusIdx] || '').trim(),
      };
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { rowFound: false, storedEmail: null, phone: '', alreadySent: false };
}

// Marca la columna H (estado_tutorial) tras un envío exitoso. Best-effort.
async function markTutorialSent(config, programa, storedEmail) {
  try {
    await updateRow(
      config.googleCredentialsPath,
      programa.comprasSheetId,
      programa.comprasSheetRange,
      COMPRAS_COL.email, // match exacto por correo (col B)
      storedEmail,
      { [COMPRAS_COL.statusLetter]: `WA_OK|${new Date().toISOString()}` }
    );
  } catch (err) {
    logger.warn({ msg: 'No se pudo marcar estado_tutorial en Sheet', email: storedEmail, err: err.message });
  }
}

// Método anterior (plan B): avisa a n8n para que Chatwoot envíe el tutorial.
// NO recrea la lógica de Chatwoot, solo dispara el webhook ya configurado.
async function triggerN8nFallback(programa, info) {
  const url = programa.tutorialFallbackWebhook;
  if (!url) throw new Error('fallback_webhook_no_configurado');
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'send_tutorial',
      reason: 'whatsapp_failed',
      email: info.email,
      txnId: info.txnId,
      programName: info.programName,
      timestamp: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`n8n fallback error: ${res.status} ${txt}`);
  }
  return true;
}

// Orquesta el envío del tutorial: intenta WhatsApp; ante CUALQUIER fallo cae al
// webhook de n8n (flujo antiguo intacto). Nunca relanza: no puede tumbar el proceso.
async function sendTutorialWithFallback(config, programa, payload) {
  const { email, txnId } = getBuyerInfo(payload);
  if (!email) {
    logger.warn({ msg: 'Sin correo en payload; no se envia tutorial', programa: programa.name });
    return;
  }

  try {
    // 1) El cliente de WhatsApp debe estar listo. Si no, ni leemos el Sheet: va al fallback.
    if (!isWhatsAppReady()) throw new Error('whatsapp_no_listo');

    // 2) Idempotencia + teléfono desde "Compras de Hotmart" (por correo)
    const { phone, alreadySent, storedEmail } = await lookupPhoneByEmail(config, programa, email);
    if (alreadySent) {
      logger.info({ msg: 'Tutorial ya enviado previamente, se omite', email });
      return;
    }
    if (!phone) throw new Error('telefono_no_encontrado');

    // 3) Enviar por WhatsApp (lanza si el número no está en WA, sesión caída, timeout, etc.)
    await sendTutorial(phone, config.tutorialMessage, {
      countryCode: config.whatsapp && config.whatsapp.defaultCountryCode,
    });

    // 4) Marcar como enviado (durable: sobrevive reinicios y webhooks Hotmart duplicados)
    await markTutorialSent(config, programa, storedEmail || email);
    logger.info({ msg: 'Tutorial enviado por WhatsApp', email, programa: programa.name });
  } catch (waErr) {
    // 5) FALLBACK — método anterior INTACTO: n8n/Chatwoot envía el tutorial
    logger.warn({ msg: 'WhatsApp fallo; usando fallback n8n/Chatwoot', email, err: waErr.message });
    try {
      await triggerN8nFallback(programa, { email, txnId, programName: programa.name });
      logger.info({ msg: 'Fallback n8n disparado', email });
    } catch (fbErr) {
      logger.error({ msg: 'Fallback n8n tambien fallo', email, err: fbErr.message });
      // no relanza: el webhook ya respondió y el proceso no debe caerse
    }
  }
}

function setup(client, config) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Construir set de todos los productos validos
  const allValidProducts = new Set();
  for (const prog of Object.values(config.PROGRAMS)) {
    for (const pid of prog.products) {
      allValidProducts.add(String(pid));
    }
  }

  // Health
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.status(200).send('OK'));

  // QR de WhatsApp para escanear la sesión (protegido por token). El QR también
  // sale como ASCII en los logs del contenedor (docker logs).
  app.get('/wa/qr', async (req, res) => {
    try {
      const token = req.query.token;
      if (!config.whatsapp || !config.whatsapp.qrToken || token !== config.whatsapp.qrToken) {
        return res.status(401).send('unauthorized');
      }
      const { ready, qr } = getQrState();
      if (ready) return res.send('<h2>WhatsApp ya está autenticado ✅</h2>');
      if (!qr) return res.send('<h2>Aún no hay QR disponible. Espera unos segundos y recarga.</h2>');

      if (QRCode) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        return res.send(
          `<!doctype html><html><body style="text-align:center;font-family:sans-serif;padding:24px">` +
            `<h2>Escanea este código con WhatsApp</h2>` +
            `<img src="${dataUrl}" alt="QR de WhatsApp"/>` +
            `<p>Si el QR expira, recarga la página.</p></body></html>`
        );
      }
      // Sin librería qrcode: devolver el string para pegarlo en un generador externo.
      return res.type('text/plain').send(qr);
    } catch (err) {
      logger.error({ msg: 'Error en /wa/qr', err: err.message });
      return res.status(500).send('error: ' + err.message);
    }
  });

  // Endpoint para generar invite por programa (usado por n8n / WhatsApp)
  app.get('/api/invite/:programa', async (req, res) => {
    try {
      const programKey = req.params.programa;
      const programa = config.PROGRAMS[programKey];
      if (!programa) {
        return res.status(404).json({ ok: false, error: 'programa_no_encontrado' });
      }

      const inviteUrl = await createOneUseInvite(config.token, programa.inviteChannelId);
      logger.info({ msg: 'Invite generado via API', programa: programa.name, inviteUrl });
      return res.json({ ok: true, inviteUrl });
    } catch (err) {
      logger.error({ msg: 'Error generando invite', err: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Webhook Hotmart (recibe compras aprobadas)
  app.post('/api/hotmart/webhook', async (req, res) => {
    try {
      const incomingTok = req.get('X-HOTMART-HOTTOK') || req.query.hottok;
      if (!config.hottok || incomingTok !== config.hottok) {
        logger.warn({ msg: 'HOTTOK invalido o ausente' });
        return res.status(401).json({ ok: false, error: 'invalid_hottok' });
      }

      const payload = req.body || {};
      const event = payload?.event || payload?.event_type || 'unknown_event';
      const status = payload?.data?.status || payload?.purchase?.status || payload?.status || 'UNKNOWN';
      const productId = getProductIdFrom(payload, allValidProducts);

      logger.info({ msg: 'Webhook recibido', event, status, productId });

      const normalEvent = String(event).toLowerCase();
      const normalStatus = String(status).toUpperCase();
      const isApproved =
        normalStatus.includes('APPROVED') ||
        normalEvent.includes('purchase_approved') ||
        normalEvent.includes('purchase_complete') ||
        normalEvent.includes('approved');

      const isValidProduct = productId && allValidProducts.has(String(productId));

      if (!isApproved || !isValidProduct) {
        logger.info({ msg: 'Evento ignorado', isApproved, isValidProduct, productId });
        return res.json({ ok: true, ignored: true });
      }

      const programa = config.getProgramByProductId(productId);
      if (!programa) {
        logger.warn({ msg: 'Producto sin programa asociado', productId });
        return res.json({ ok: true, ignored: true });
      }

      limiter
        .schedule(() => processApprovedPurchase(payload, programa, config.token))
        .catch(err => logger.error({ msg: 'Error en tarea', err: err.message }));

      // Tarea independiente: tutorial por WhatsApp con fallback a n8n/Chatwoot.
      // Desacoplada del invite/email: si una falla, la otra no se ve afectada.
      limiter
        .schedule(() => sendTutorialWithFallback(config, programa, payload))
        .catch(err => logger.error({ msg: 'Error en tarea tutorial', err: err.message }));

      return res.json({ ok: true, queued: true });
    } catch (err) {
      logger.error({ msg: 'Error en webhook', err: err.message });
      return res.status(500).json({ ok: false });
    }
  });

  // Iniciar server
  setInterval(cleanupInviteCache, CACHE_CLEANUP_MS);
  app.listen(config.port, () => {
    logger.info(`Invites API escuchando en http://localhost:${config.port}`);
    logger.info('Endpoints: GET /api/invite/:programa | POST /api/hotmart/webhook | GET /wa/qr');
  });

  logger.info('Modulo invites cargado');
}

module.exports = {
  setup,
  // Exportados para pruebas / reuso:
  getBuyerInfo,
  lookupPhoneByEmail,
  markTutorialSent,
  triggerN8nFallback,
  sendTutorialWithFallback,
};
