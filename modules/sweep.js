const { Events } = require('discord.js');
const cron = require('node-cron');
const { logger } = require('../utils/logger');
const {
  getRows,
  batchUpdateValues,
  batchAppendRows,
  archiveRowsByUserIds,
  archiveRowByUserId,
  matchesUserId,
  parseRange,
} = require('../utils/sheets');
const {
  markSweep,
  clearSweep,
  drainDeferredArchives,
  isArchiving,
  markArchiving,
  clearArchiving,
  hasPendingArchiveForGuild,
} = require('../utils/locks');

// Margen permitido entre lo reportado por el gateway y lo realmente fetcheado
// (por joins/leaves durante el fetch). Por debajo de esto NO se archiva (posible fetch parcial).
const ARCHIVE_FETCH_EPSILON = 2;

// Guard por proceso contra solapamiento de barridos.
let isSweeping = false;

/**
 * Reconciliación completa de UN programa. Una lectura del Sheet + escrituras batch.
 * Orden de aplicación (carga semántica, NO reordenar): correcciones → altas → archivado.
 * - correcciones usan índices del snapshot → deben ir antes de cualquier borrado.
 * - altas hacen append al final → no desplazan el snapshot.
 * - archivado borra por índices del snapshot (descendente).
 * Con { dryRun:true } no escribe nada; devuelve el reporte de lo que haría.
 */
async function runSweep(client, config, programa, { dryRun = false } = {}) {
  const log = logger.child({ programa: programa.name });
  const startedAt = Date.now();
  const report = {
    programa: programa.name,
    added: [],
    archived: [],
    corrected: [],
    errors: 0,
    skippedArchive: false,
    dryRun,
  };

  const guild = client.guilds.cache.get(programa.guildId);
  if (!guild) {
    log.warn({ msg: 'Guild no está en cache, saltando programa', guildId: programa.guildId });
    return report;
  }

  // 1. Fetch masivo de TODOS los miembros (un solo request del gateway).
  let members;
  try {
    members = await guild.members.fetch();
  } catch (e) {
    log.error({ msg: 'Error en members.fetch(), saltando programa', err: e.message });
    report.errors++;
    return report;
  }

  // En dry-run NO se marca activeSweeps ni se espera: el dry-run retorna ANTES de
  // cualquier escritura (paso 5), así que no puede corromper índices aunque otro actor
  // borre filas en paralelo — solo produciría un reporte ligeramente desactualizado.
  const sweepMarked = !dryRun;
  if (sweepMarked) {
    markSweep(programa.guildId);
    // Cerrar la ventana de un archivado en-vuelo iniciado JUSTO antes de markSweep:
    // cleanup marca pendingArchive sincrónicamente antes de su primer await, y tras
    // markSweep ningún archivado nuevo puede empezar (cleanup difiere). Esperar a que
    // se liberen los en-vuelo evita que un delete concurrente desplace los índices del snapshot.
    const settleStart = Date.now();
    while (hasPendingArchiveForGuild(programa.guildId) && Date.now() - settleStart < 10000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (hasPendingArchiveForGuild(programa.guildId)) {
      log.warn({ msg: 'Archivado en curso no liberó a tiempo; el barrido continúa', guildId: programa.guildId });
    }
  }

  try {
    // 2. Una sola lectura del Sheet.
    let rows;
    try {
      rows = await getRows(config.googleCredentialsPath, programa.sheetId, programa.sheetRange);
    } catch (e) {
      log.error({ msg: 'Error leyendo Sheet, saltando programa', err: e.message });
      report.errors++;
      return report;
    }

    const { sheetName, startRow } = parseRange(programa.sheetRange);

    // Índices de pertenencia tolerantes a precisión (ambos sentidos).
    const discordExact = new Set();
    const discordPrefix = new Set();
    const discordById = new Map();
    for (const m of members.values()) {
      discordById.set(m.id, m);
      discordExact.add(String(m.id));
      discordPrefix.add(String(m.id).slice(0, 15));
    }
    const discordHas = (storedId) => {
      const s = (storedId || '').trim();
      return discordExact.has(s) || (s.length >= 15 && discordPrefix.has(s.slice(0, 15)));
    };
    const findMember = (storedId) => {
      let m = discordById.get(storedId);
      if (m) return m;
      if (storedId.length >= 15) {
        for (const cand of members.values()) {
          if (matchesUserId(storedId, cand.id)) return cand;
        }
      }
      return null;
    };

    const sheetExact = new Set();
    const sheetPrefix = new Set();
    rows.forEach((r) => {
      const id = (r[3] || '').trim();
      if (!id) return;
      sheetExact.add(id);
      if (id.length >= 15) sheetPrefix.add(id.slice(0, 15));
    });
    const sheetHas = (userId) => {
      const s = String(userId);
      return sheetExact.has(s) || sheetPrefix.has(s.slice(0, 15));
    };

    // 3. Clasificar en memoria (sin llamadas a API).
    // 3a. En Discord y no en Sheet → alta.
    const toAddRows = [];
    for (const m of members.values()) {
      if (sheetHas(m.id)) continue;
      const fila = [m.user.username, m.displayName, m.user.tag, m.id];
      for (let c = 0; c < programa.roleColumns.length; c++) fila.push('');
      toAddRows.push(fila);
    }
    report.added = toAddRows.map((r) => r[3]);

    // 3b. Recorrer filas del Sheet: archivar las ausentes / corregir A/B/C de las presentes.
    const toArchiveIds = [];
    const corrections = [];
    rows.forEach((r, i) => {
      const id = (r[3] || '').trim();
      if (!id) return;

      if (!discordHas(id)) {
        toArchiveIds.push(id);
        return;
      }

      const member = findMember(id);
      if (!member) return;
      const desired = [member.user.username, member.displayName, member.user.tag];
      const differs =
        (r[0] ?? '').toString() !== desired[0] ||
        (r[1] ?? '').toString() !== desired[1] ||
        (r[2] ?? '').toString() !== desired[2];
      if (differs) {
        const rowNum = startRow + i;
        corrections.push({ range: `${sheetName}!A${rowNum}:C${rowNum}`, values: [desired] });
        report.corrected.push(id);
      }
    });

    // 4. Guard estricto anti-fetch-parcial para la fase de ARCHIVADO.
    const fetchedOk = members.size >= guild.memberCount - ARCHIVE_FETCH_EPSILON;
    if (!fetchedOk && toArchiveIds.length) {
      report.skippedArchive = true;
      log.error({
        msg: 'Fetch posiblemente parcial: se OMITE el archivado (altas/correcciones sí proceden)',
        fetched: members.size,
        memberCount: guild.memberCount,
        candidatos: toArchiveIds.length,
      });
    }
    const archiveIds = report.skippedArchive ? [] : toArchiveIds;
    report.archived = archiveIds;

    // 5. Dry-run: reportar sin escribir.
    if (dryRun) {
      log.info({
        msg: 'Sweep DRY-RUN',
        added: report.added.length,
        archived: report.archived.length,
        corrected: report.corrected.length,
        skippedArchive: report.skippedArchive,
      });
      return report;
    }

    // 6. Aplicar EN ORDEN: correcciones → altas → archivado.
    try {
      await batchUpdateValues(config.googleCredentialsPath, programa.sheetId, corrections);
    } catch (e) {
      report.errors++;
      log.error({ msg: 'Error aplicando correcciones', err: e.message });
    }

    try {
      await batchAppendRows(config.googleCredentialsPath, programa.sheetId, sheetName, toAddRows);
    } catch (e) {
      report.errors++;
      log.error({ msg: 'Error aplicando altas', err: e.message });
    }

    if (archiveIds.length) {
      // Excluir los userId que la ruta evento esté archivando en este momento.
      const filtered = archiveIds.filter((id) => !isArchiving(programa.guildId, id));
      filtered.forEach((id) => markArchiving(programa.guildId, id));
      try {
        await archiveRowsByUserIds(
          config.googleCredentialsPath,
          programa.sheetId,
          programa.sheetRange,
          programa.bajasSheetName,
          rows,
          filtered,
          { source: 'sweep' }
        );
      } catch (e) {
        report.errors++;
        log.error({ msg: 'Error en archivado batch', err: e.message });
      } finally {
        filtered.forEach((id) => clearArchiving(programa.guildId, id));
      }
    }

    return report;
  } finally {
    if (sweepMarked) {
      clearSweep(programa.guildId);
      // Drenar bajas en tiempo real que llegaron durante el barrido (índices ya frescos).
      const deferred = drainDeferredArchives(programa.guildId);
      for (const userId of deferred) {
        if (isArchiving(programa.guildId, userId)) continue;
        markArchiving(programa.guildId, userId);
        try {
          await archiveRowByUserId(
            config.googleCredentialsPath,
            programa.sheetId,
            programa.sheetRange,
            programa.bajasSheetName,
            3,
            userId,
            { source: 'event-deferred' }
          );
        } catch (e) {
          log.error({ msg: 'Error archivando baja diferida', user: userId, err: e.message });
        } finally {
          clearArchiving(programa.guildId, userId);
        }
      }
    }
    log.info({
      msg: 'Sweep completado',
      added: report.added.length,
      archived: report.archived.length,
      corrected: report.corrected.length,
      errors: report.errors,
      skippedArchive: report.skippedArchive,
      durationMs: Date.now() - startedAt,
      dryRun,
    });
  }
}

/** Corre el barrido para todos los programas configurados. Devuelve los reportes. */
async function runSweepAll(client, config, opts = {}) {
  if (isSweeping) {
    logger.warn('Barrido anterior aún en curso, saltando');
    return [];
  }
  isSweeping = true;
  const reports = [];
  try {
    for (const programa of Object.values(config.PROGRAMS)) {
      if (!programa.guildId || !programa.sheetId) continue;
      try {
        reports.push(await runSweep(client, config, programa, opts));
      } catch (e) {
        logger.error({ msg: 'Error en barrido de programa', programa: programa.name, err: e.message });
      }
    }
    const agg = reports.reduce(
      (a, r) => ({
        added: a.added + r.added.length,
        archived: a.archived + r.archived.length,
        corrected: a.corrected + r.corrected.length,
        errors: a.errors + r.errors,
      }),
      { added: 0, archived: 0, corrected: 0, errors: 0 }
    );
    logger.info({ msg: 'Barrido global completado', ...agg, programas: reports.length, dryRun: !!opts.dryRun });
  } finally {
    isSweeping = false;
  }
  return reports;
}

function setup(client, config) {
  client.once(Events.ClientReady, () => {
    cron.schedule(
      '0 3 * * *',
      () => {
        runSweepAll(client, config, { dryRun: false }).catch((err) =>
          logger.error({ msg: 'Barrido cron falló', err: err.message })
        );
      },
      { timezone: 'America/Bogota' }
    );
    logger.info('Modulo sweep cargado (barrido diario 03:00 America/Bogota)');
  });
}

module.exports = { setup, runSweep, runSweepAll };
