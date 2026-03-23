const {
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  InteractionType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { logger } = require('../utils/logger');
const { asignarRoles } = require('../utils/discord');
const { updateRow } = require('../utils/sheets');
const { markVerified } = require('./roles');

// ── Pasos de aceptación obligatoria (compartidos entre programas) ──
const PASOS_ACEPTACION = [
  {
    id: 'terminos',
    titulo: 'Terminos y Condiciones',
    descripcion:
      'Acepto los terminos y condiciones del programa.\n\nPuedes leer el documento completo aqui:\nhttps://drive.google.com/file/d/1jbJUrvLoHY9zdxXXzWY9Mvpqg6BaLfZt/view',
  },
  {
    id: 'privacidad',
    titulo: 'Politica de Privacidad y Tratamiento de Datos',
    descripcion:
      'Autorizo el tratamiento de mis datos personales.\n\nPuedes revisar nuestra politica de privacidad completa aqui:\nhttps://drive.google.com/file/d/13LTwFcyv5IWMP7K6unusvg79aQyygrjn/view',
  },
  {
    id: 'reglamento',
    titulo: 'Reglamento de la Comunidad',
    descripcion:
      'Me comprometo a mantener el respeto, no hacer spam y seguir las normas de convivencia de este espacio.\n\nhttps://drive.google.com/file/d/1eqvbywVNk7BjLP6hWYKnTO4DfVeRpRFZ/view?usp=sharing',
  },
  {
    id: 'exencion',
    titulo: 'Exencion de Responsabilidad',
    descripcion:
      'Comprendo y acepto que toda la informacion y analisis compartido tiene fines estrictamente academicos. Nada constituye asesoria financiera ni recomendacion directa de inversion. Entiendo que invertir conlleva riesgos y soy el unico responsable de mis decisiones financieras.',
  },
];

function crearPasoAceptacion(pasoIndex) {
  const paso = PASOS_ACEPTACION[pasoIndex];
  const embed = new EmbedBuilder()
    .setTitle(paso.titulo)
    .setDescription(paso.descripcion)
    .setFooter({ text: `Paso ${pasoIndex + 1} de ${PASOS_ACEPTACION.length}` })
    .setColor(0x2b2d31);

  const botones = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`acepto_paso_${pasoIndex}`)
      .setLabel('Acepto')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`no_acepto_paso_${pasoIndex}`)
      .setLabel('No Acepto')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [botones] };
}

function setup(client, config) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // ── Clic en botón de verificación → Iniciar flujo de aceptación ──
      if (interaction.isButton() && interaction.customId === 'boton_validar_hotmart') {
        const paso = crearPasoAceptacion(0);
        await interaction.reply({ ...paso, flags: 64 });
        logger.info({ msg: 'Flujo de aceptacion iniciado', user: interaction.user.tag });
        return;
      }

      // ── Botones de aceptación/rechazo ──
      if (interaction.isButton()) {
        const matchAcepto = interaction.customId.match(/^acepto_paso_(\d+)$/);
        const matchNoAcepto = interaction.customId.match(/^no_acepto_paso_(\d+)$/);

        if (matchNoAcepto) {
          const pasoIndex = parseInt(matchNoAcepto[1]);
          const paso = crearPasoAceptacion(pasoIndex);
          await interaction.update({
            content: '**Para permanecer en la comunidad es obligatorio aceptar.** Por favor selecciona una opcion:',
            ...paso,
          });
          return;
        }

        if (matchAcepto) {
          const pasoIndex = parseInt(matchAcepto[1]);
          const siguientePaso = pasoIndex + 1;

          if (siguientePaso < PASOS_ACEPTACION.length) {
            const paso = crearPasoAceptacion(siguientePaso);
            await interaction.update({ content: '', ...paso });
            return;
          }

          // Todos los pasos aceptados → Mostrar modal de código HP
          const modal = new ModalBuilder()
            .setCustomId('modal_codigo_hp')
            .setTitle('Validar tu compra de Hotmart');

          const codigoInput = new TextInputBuilder()
            .setCustomId('codigo_hp')
            .setLabel('Codigo de transaccion (empieza con HP)')
            .setPlaceholder('Ej: HP2489507294')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(5)
            .setMaxLength(30);

          const row = new ActionRowBuilder().addComponents(codigoInput);
          modal.addComponents(row);

          await interaction.showModal(modal);
          logger.info({ msg: 'Modal HP mostrado', user: interaction.user.tag });
          return;
        }
      }

      // ── Submit del Modal → Validar código con n8n ──
      if (
        interaction.type === InteractionType.ModalSubmit &&
        interaction.customId === 'modal_codigo_hp'
      ) {
        const codigoHP = interaction.fields.getTextInputValue('codigo_hp').trim();
        const userId = interaction.user.id;
        const userName = interaction.user.tag;
        const guildId = interaction.guildId;

        logger.info({ msg: 'Codigo recibido', codigoHP, userName, userId });

        await interaction.deferReply({ flags: 64 });

        // Buscar programa por guildId
        const programa = config.getProgramByGuildId(guildId);
        if (!programa) {
          await interaction.editReply({ content: 'Error: servidor no configurado.' });
          logger.error({ msg: 'Guild no encontrado en config', guildId });
          return;
        }

        if (!programa.webhookN8n) {
          await interaction.editReply({
            content: 'Sistema de validacion en configuracion. Intenta mas tarde.',
          });
          return;
        }

        // Enviar datos a n8n
        try {
          const response = await fetch(programa.webhookN8n, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              codigoHP,
              userId,
              userName,
              guildId,
              timestamp: new Date().toISOString(),
            }),
          });

          const data = await response.json();

          if (data.success) {
            // Asignar roles del programa correspondiente
            const guild = await client.guilds.fetch(guildId);
            const rolesResult = await asignarRoles(guild, userId, programa.roles);

            // Marcar usuario como recién verificado para que el sync no toque sus roles por 2 min
            markVerified(guildId, userId);

            // Escribir roles en las columnas correspondientes del Sheet para que roles.js no los quite
            try {
              const updates = {};
              for (let i = 0; i < programa.roles.length && i < programa.roleColumns.length; i++) {
                updates[programa.roleColumns[i].letter] = programa.roles[i];
              }
              const updated = await updateRow(
                config.googleCredentialsPath,
                programa.sheetId,
                programa.sheetRange,
                3, // columna D = userId (índice 3)
                userId,
                updates
              );
              if (updated) {
                logger.info({ msg: 'Roles escritos en Sheet', userId, roles: programa.roles });
              } else {
                logger.warn({ msg: 'Usuario no encontrado en Sheet para actualizar roles', userId });
              }
            } catch (sheetErr) {
              logger.error({ msg: 'Error escribiendo roles en Sheet', userId, err: sheetErr.message });
            }

            let mensajeFinal = data.message;
            if (rolesResult.rolesAsignados.length > 0) {
              mensajeFinal += `\n\nRoles asignados: **${rolesResult.rolesAsignados.join('**, **')}**`;
            }
            if (rolesResult.rolesNoEncontrados.length > 0) {
              mensajeFinal += '\nAlgunos roles no se pudieron asignar. Contacta soporte.';
            }

            await interaction.editReply({ content: mensajeFinal });
            logger.info({ msg: 'Validacion exitosa', userName, programa: programa.name });
          } else {
            await interaction.editReply({ content: data.message });
            logger.info({ msg: 'Validacion fallida', userName, reason: data.message });
          }
        } catch (fetchError) {
          logger.error({ msg: 'Error al contactar n8n', err: fetchError.message });
          await interaction.editReply({
            content: 'Hubo un error al validar tu codigo. Por favor intenta de nuevo en unos minutos.',
          });
        }

        return;
      }
    } catch (error) {
      logger.error({ msg: 'Error en interaccion', err: error.message });
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: 'Ocurrio un error inesperado. Intenta de nuevo.' });
        } else {
          await interaction.reply({ content: 'Ocurrio un error inesperado. Intenta de nuevo.', flags: 64 });
        }
      } catch (_) {}
    }
  });

  logger.info('Modulo verificacion cargado');
}

module.exports = { setup };
