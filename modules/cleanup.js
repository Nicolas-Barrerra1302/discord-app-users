const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { archiveRowByUserId } = require('../utils/sheets');
const {
  isSweepActive,
  enqueueDeferredArchive,
  isArchiving,
  markArchiving,
  clearArchiving,
} = require('../utils/locks');

function setup(client, config) {
  // Guard contra archivados concurrentes del mismo usuario (mismo proceso).
  const pendingRemoves = new Set();

  client.on(Events.GuildMemberRemove, async (member) => {
    const programa = config.getProgramByGuildId(member.guild.id);
    if (!programa) return;

    const log = logger.child({ programa: programa.name });
    const dedupKey = `${programa.guildId}:${member.id}`;
    const tag = member.user?.tag || member.id;

    if (pendingRemoves.has(dedupKey)) return;
    pendingRemoves.add(dedupKey);

    try {
      // Si hay un barrido en curso para este guild, NO tocar el tab principal
      // (el barrido tiene un snapshot vivo con índices absolutos). Diferir el
      // archivado: el barrido lo procesa al terminar, con índices frescos.
      if (isSweepActive(programa.guildId)) {
        enqueueDeferredArchive(programa.guildId, member.id);
        log.info({ msg: 'Baja diferida (barrido en curso)', user: tag });
        return;
      }

      // Guard cruzado evento↔barrido para el mismo usuario.
      if (isArchiving(programa.guildId, member.id)) return;
      markArchiving(programa.guildId, member.id);

      try {
        const { archived, deleted } = await archiveRowByUserId(
          config.googleCredentialsPath,
          programa.sheetId,
          programa.sheetRange,
          programa.bajasSheetName,
          3, // columna D = userId (índice 3)
          member.id,
          { source: 'event' }
        );

        if (archived === 0 && deleted === 0) {
          log.info({ msg: 'Miembro no estaba en Sheets, omitiendo', user: tag });
        } else if (deleted > 1 || archived > 1) {
          log.warn({ msg: 'Filas duplicadas archivadas en Bajas', user: tag, archived, deleted });
        } else {
          log.info({ msg: 'Miembro archivado en Bajas', user: tag });
        }
      } finally {
        clearArchiving(programa.guildId, member.id);
      }
    } catch (err) {
      log.error({ msg: 'Error archivando miembro', user: member.id, err: err.message });
    } finally {
      pendingRemoves.delete(dedupKey);
    }
  });

  logger.info('Modulo cleanup cargado (archivado en hoja Bajas)');
}

module.exports = { setup };
