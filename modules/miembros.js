const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { getRows, appendRow } = require('../utils/sheets');

function setup(client, config) {
  // Guard contra escrituras concurrentes del mismo usuario
  const pendingAdds = new Set();

  client.on(Events.GuildMemberAdd, async (member) => {
    const programa = config.getProgramByGuildId(member.guild.id);
    if (!programa) return;

    const log = logger.child({ programa: programa.name });
    const dedupKey = `${programa.guildId}:${member.id}`;

    // Si ya hay una escritura en curso para este usuario, omitir
    if (pendingAdds.has(dedupKey)) return;
    pendingAdds.add(dedupKey);

    try {
      const username = member.user.username;
      const visibleName = member.displayName;
      const tag = member.user.tag;
      const id = member.id;

      // Verificar si el usuario ya existe en el Sheet (columna D = userId)
      // Comparar tanto exacto como con startsWith para manejar userIds con pérdida de precisión numérica
      const rows = await getRows(config.googleCredentialsPath, programa.sheetId, programa.sheetRange);
      const exists = rows.some(row => {
        const stored = (row[3] || '').trim();
        return stored === id || stored.startsWith(id.slice(0, 15));
      });
      if (exists) {
        log.info({ msg: 'Miembro ya existe en Sheets, omitiendo', user: tag });
        return;
      }

      // Construir fila con columnas vacías para cada columna de rol
      const fila = [username, visibleName, tag, id];
      for (const _col of programa.roleColumns) {
        fila.push('');
      }
      await appendRow(
        config.googleCredentialsPath,
        programa.sheetId,
        `${programa.sheetRange.split('!')[0]}!A1`,
        fila
      );

      log.info({ msg: 'Nuevo miembro registrado en Sheets', user: tag });
    } catch (err) {
      log.error({ msg: 'Error registrando miembro nuevo', err: err.message });
    } finally {
      pendingAdds.delete(dedupKey);
    }
  });

  logger.info('Modulo miembros cargado');
}

module.exports = { setup };
