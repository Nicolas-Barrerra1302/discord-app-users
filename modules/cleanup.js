const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { deleteRowsByMatch } = require('../utils/sheets');

function setup(client, config) {
  // Guard contra borrados concurrentes del mismo usuario
  const pendingRemoves = new Set();

  client.on(Events.GuildMemberRemove, async (member) => {
    const programa = config.getProgramByGuildId(member.guild.id);
    if (!programa) return;

    const log = logger.child({ programa: programa.name });
    const dedupKey = `${programa.guildId}:${member.id}`;

    if (pendingRemoves.has(dedupKey)) return;
    pendingRemoves.add(dedupKey);

    try {
      const tag = member.user?.tag || member.id;

      // Eliminar fila(s) por userId en columna D (indice 3)
      const { deleted } = await deleteRowsByMatch(
        config.googleCredentialsPath,
        programa.sheetId,
        programa.sheetRange,
        3,
        member.id
      );

      if (deleted === 0) {
        log.info({ msg: 'Miembro no encontrado en Sheets, omitiendo', user: tag });
      } else if (deleted === 1) {
        log.info({ msg: 'Miembro eliminado de Sheets', user: tag });
      } else {
        log.warn({ msg: 'Filas duplicadas eliminadas de Sheets', user: tag, count: deleted });
      }
    } catch (err) {
      log.error({ msg: 'Error eliminando miembro de Sheets', user: member.id, err: err.message });
    } finally {
      pendingRemoves.delete(dedupKey);
    }
  });

  logger.info('Modulo cleanup cargado');
}

module.exports = { setup };
