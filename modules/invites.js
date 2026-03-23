const express = require('express');
const { fetch } = require('undici');
const Bottleneck = require('bottleneck');
const { logger } = require('../utils/logger');

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
  const body = { max_uses: 1, max_age: 86400, unique: true, temporary: false };

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
        Este enlace es <b style="color:#e6f5ff;">de un solo uso</b> y expira en <b style="color:#e6f5ff;">24 horas</b>.
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
    logger.info('Endpoints: GET /api/invite/:programa | POST /api/hotmart/webhook');
  });

  logger.info('Modulo invites cargado');
}

module.exports = { setup };
