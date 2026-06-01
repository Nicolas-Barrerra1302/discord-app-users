/**
 * Entrypoint manual del barrido de reconciliación Discord ↔ Sheets.
 *
 * Uso (correr con el BOT PRINCIPAL DETENIDO — regla de un-solo-proceso):
 *   node run-sweep.js            → DRY-RUN: no escribe nada, solo reporta.
 *   node run-sweep.js --apply    → aplica de verdad (altas, correcciones, archivado).
 *
 * Crea un client mínimo (sin registrar miembros/cleanup/etc.), así que aunque se
 * ejecutara solo, no dispara escrituras por evento. El cron de las 03:00 corre dentro
 * del bot vivo usando la misma función runSweepAll.
 */
const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { logger } = require('./utils/logger');
const { runSweepAll } = require('./modules/sweep');

const apply = process.argv.includes('--apply');
const dryRun = !apply;

if (!config.token) {
  logger.error('Falta DISCORD_TOKEN en las variables de entorno');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async () => {
  logger.info({ msg: `run-sweep conectado como ${client.user.tag}`, modo: dryRun ? 'DRY-RUN' : 'APPLY' });
  if (dryRun) {
    logger.info('DRY-RUN: no se escribirá nada en Sheets. Usa --apply para aplicar.');
  }

  let code = 0;
  try {
    const reports = await runSweepAll(client, config, { dryRun });
    // Reporte detallado por programa.
    for (const r of reports) {
      logger.info({
        msg: `Reporte ${r.programa}`,
        counts: { added: r.added.length, archived: r.archived.length, corrected: r.corrected.length },
        skippedArchive: r.skippedArchive,
        errors: r.errors,
        dryRun: r.dryRun,
      });
    }
    // Detalle completo (UserIDs) a stdout para revisión.
    console.log(JSON.stringify(reports, null, 2));
  } catch (e) {
    logger.error({ msg: 'run-sweep falló', err: e.message });
    code = 1;
  } finally {
    await client.destroy();
    process.exit(code);
  }
});

client.login(config.token);
