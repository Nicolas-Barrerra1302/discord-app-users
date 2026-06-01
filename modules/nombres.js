const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { getRows, updateIdentityCells, matchesUserId } = require('../utils/sheets');

// Mapa de columna de identidad → letra de hoja. A=username, B=visibleName, C=tag.
const IDENTITY_COLS = [
  { index: 0, letter: 'A' },
  { index: 1, letter: 'B' },
  { index: 2, letter: 'C' },
];

function setup(client, config) {
  // Coalescing de ráfagas (apodo + userUpdate casi simultáneos) por usuario.
  const pendingNameSync = new Set();

  /**
   * Recalcula A/B/C desde el GuildMember (misma derivación que miembros.js) y
   * actualiza SOLO esa fila SOLO si difiere. Nunca crea filas ni toca D/E/F/G.
   */
  async function syncMemberName(member, programa, log) {
    const key = `${programa.guildId}:${member.id}`;
    if (pendingNameSync.has(key)) return; // ya hay un sync en curso para este usuario
    pendingNameSync.add(key);

    try {
      const desired = [
        member.user.username, // A
        member.displayName,   // B
        member.user.tag,      // C
      ];

      const rows = await getRows(config.googleCredentialsPath, programa.sheetId, programa.sheetRange);
      const row = rows.find(r => matchesUserId(r[3], member.id));
      if (!row) return; // la creación es de GuildMemberAdd / barrido; aquí no se crea

      const updates = {};
      for (const { index, letter } of IDENTITY_COLS) {
        const current = (row[index] ?? '').toString();
        if (current !== desired[index]) updates[letter] = desired[index];
      }
      if (Object.keys(updates).length === 0) return; // no-op (incluye cambios de solo-rol)

      const ok = await updateIdentityCells(
        config.googleCredentialsPath,
        programa.sheetId,
        programa.sheetRange,
        member.id,
        updates
      );
      if (ok) {
        log.info({ msg: 'Nombre sincronizado', user: member.user.tag, columnas: Object.keys(updates) });
      }
    } finally {
      pendingNameSync.delete(key);
    }
  }

  // ── Cambios a nivel servidor: apodo, roles ──
  client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
    try {
      const programa = config.getProgramByGuildId(newM.guild.id);
      if (!programa) return;

      // Early-diff: si nada que afecte A/B/C cambió (p.ej. solo roles) → no leer el Sheet.
      const sameName =
        oldM.nickname === newM.nickname &&
        oldM.user.username === newM.user.username &&
        oldM.user.discriminator === newM.user.discriminator &&
        oldM.user.globalName === newM.user.globalName;
      if (sameName) return;

      await syncMemberName(newM, programa, logger.child({ programa: programa.name }));
    } catch (err) {
      logger.error({ msg: 'Error en guildMemberUpdate', user: newM?.id, err: err.message });
    }
  });

  // ── Cambios de cuenta global: username/discriminator/global name ──
  client.on(Events.UserUpdate, async (oldU, newU) => {
    try {
      // Early-diff: solo avatar u otros campos no-identidad → ignorar.
      const sameIdentity =
        oldU.username === newU.username &&
        oldU.discriminator === newU.discriminator &&
        oldU.globalName === newU.globalName;
      if (sameIdentity) return;

      // B (displayName) es por-guild; resolver el member en cada servidor configurado.
      for (const programa of Object.values(config.PROGRAMS)) {
        if (!programa.guildId || !programa.sheetId) continue;
        const guild = client.guilds.cache.get(programa.guildId);
        if (!guild) continue;

        let member = guild.members.cache.get(newU.id);
        if (!member) {
          try {
            member = await guild.members.fetch(newU.id);
          } catch (_) {
            continue; // no pertenece a este guild → saltar
          }
        }
        await syncMemberName(member, programa, logger.child({ programa: programa.name }));
      }
    } catch (err) {
      logger.error({ msg: 'Error en userUpdate', user: newU?.id, err: err.message });
    }
  });

  logger.info('Modulo nombres cargado (sync A/B/C por eventos)');
}

module.exports = { setup };
