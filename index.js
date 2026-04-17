const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { logger } = require('./utils/logger');

// ── Módulos ──────────────────────────────────────
const verificacion = require('./modules/verificacion');
const roles = require('./modules/roles');
const invites = require('./modules/invites');
const miembros = require('./modules/miembros');
const cleanup = require('./modules/cleanup');

// ── Cliente único ────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Registrar listeners antes del login ──────────
verificacion.setup(client, config);
roles.setup(client, config);
invites.setup(client, config);
miembros.setup(client, config);
cleanup.setup(client, config);

// ── Bot listo ────────────────────────────────────
client.once(Events.ClientReady, () => {
  logger.info(`Bot conectado como ${client.user.tag}`);

  const guilds = client.guilds.cache.map(g => `${g.name} (${g.id})`);
  logger.info({ msg: 'Servidores conectados', guilds });
});

// ── Login ────────────────────────────────────────
if (!config.token) {
  logger.error('Falta DISCORD_TOKEN en las variables de entorno');
  process.exit(1);
}

client.login(config.token);

process.on('unhandledRejection', (e) => logger.error({ msg: 'unhandledRejection', err: String(e) }));
process.on('uncaughtException', (e) => logger.error({ msg: 'uncaughtException', err: String(e) }));
