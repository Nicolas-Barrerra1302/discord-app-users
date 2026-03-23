const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { logger } = require('./logger');

async function asignarRoles(guild, userId, roleNames) {
  const member = await guild.members.fetch(userId);
  const rolesAsignados = [];
  const rolesNoEncontrados = [];

  for (const roleName of roleNames) {
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (role) {
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role);
        rolesAsignados.push(roleName);
      }
    } else {
      rolesNoEncontrados.push(roleName);
    }
  }

  if (rolesNoEncontrados.length > 0) {
    logger.warn({ msg: 'Roles no encontrados', rolesNoEncontrados, user: member.user.tag });
  }
  if (rolesAsignados.length > 0) {
    logger.info({ msg: 'Roles asignados', rolesAsignados, user: member.user.tag });
  }

  return { success: true, rolesAsignados, rolesNoEncontrados };
}

async function enviarBotonVerificacion(channel) {
  const embed = new EmbedBuilder()
    .setTitle('Verificar tu compra de Hotmart')
    .setDescription('Haz clic en el boton de abajo para validar tu acceso.')
    .setColor(0x2b2d31);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('boton_validar_hotmart')
      .setLabel('Verificar Compra')
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

module.exports = { asignarRoles, enviarBotonVerificacion };
