const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { getRows } = require('../utils/sheets');

const CHECK_INTERVAL = 60_000;

const norm = arr => [...arr].sort().join(',');

// Cache por programa: { [guildId]: { [userId]: rolesKey } }
const cacheByGuild = {};

// Skip list: usuarios recién verificados que el sync no debe tocar
const recentlyVerified = new Map();
const SKIP_TTL_MS = 120_000; // 2 minutos

/**
 * Marca un usuario como recién verificado.
 * El sync lo saltará por 2 minutos para evitar la race condition
 * entre la escritura al Sheet y el ciclo de sync en curso.
 */
function markVerified(guildId, userId) {
  recentlyVerified.set(`${guildId}:${userId}`, Date.now());
  // También actualizar cache para que el siguiente ciclo completo no re-procese
  if (!cacheByGuild[guildId]) cacheByGuild[guildId] = Object.create(null);
}

function isRecentlyVerified(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const ts = recentlyVerified.get(key);
  if (!ts) return false;
  if (Date.now() - ts < SKIP_TTL_MS) return true;
  recentlyVerified.delete(key);
  return false;
}

/**
 * Lee los roles de un usuario desde las columnas configuradas en roleColumns.
 * Cada columna contiene un único rol (no separados por ;).
 */
function readRolesFromRow(row, roleColumns) {
  const roles = [];
  for (const col of roleColumns) {
    const val = (row?.[col.index] || '').trim();
    if (val) roles.push(val);
  }
  return roles;
}

function setup(client, config) {
  // Set de roles gestionados del ciclo anterior, por guildId
  const previousManagedByGuild = {};
  // Guard contra syncs concurrentes
  let isSyncing = false;

  async function syncRoles(programa) {
    const log = logger.child({ programa: programa.name });
    const guild = client.guilds.cache.get(programa.guildId);
    if (!guild) return;

    if (!cacheByGuild[programa.guildId]) {
      cacheByGuild[programa.guildId] = Object.create(null);
    }
    const cache = cacheByGuild[programa.guildId];

    let rawRows;
    try {
      rawRows = await getRows(config.googleCredentialsPath, programa.sheetId, programa.sheetRange);
    } catch (e) {
      log.error({ msg: 'Error leyendo Sheet', err: e.message });
      return;
    }

    // ── Deduplicar filas por userId (columna D, índice 3) ──
    // Si hay duplicados, preferir la fila que tenga roles; si ninguna tiene, usar la primera
    const rowsByUser = new Map();
    for (const row of rawRows) {
      const userId = row?.[3];
      if (!userId) continue;
      const existing = rowsByUser.get(userId);
      if (!existing) {
        rowsByUser.set(userId, row);
      } else {
        const existingRoles = readRolesFromRow(existing, programa.roleColumns);
        const currentRoles = readRolesFromRow(row, programa.roleColumns);
        if (currentRoles.length > existingRoles.length) {
          rowsByUser.set(userId, row);
        }
      }
    }
    const rows = [...rowsByUser.values()];

    // ── Construir set dinámico de roles gestionados ──
    // Union de: roles del config + todos los roles encontrados en las columnas de rol + set del ciclo anterior
    const currentManagedNames = new Set(programa.roles);
    for (const row of rows) {
      for (const name of readRolesFromRow(row, programa.roleColumns)) {
        currentManagedNames.add(name);
      }
    }

    const previousManaged = previousManagedByGuild[programa.guildId] || new Set();
    const managedNames = new Set([...currentManagedNames, ...previousManaged]);

    // Guardar set actual para el próximo ciclo
    previousManagedByGuild[programa.guildId] = currentManagedNames;

    // Mapear nombres de rol gestionados → objetos Role del servidor
    const roleByName = new Map(guild.roles.cache.map(r => [r.name, r]));
    const managedRoles = new Map();
    for (const name of managedNames) {
      const role = roleByName.get(name);
      if (role) managedRoles.set(name, role);
    }

    if (managedRoles.size === 0) return;

    for (const row of rows) {
      const userId = row?.[3];
      if (!userId) continue;

      // Saltar usuarios recién verificados para evitar race condition
      if (isRecentlyVerified(programa.guildId, userId)) continue;

      const desiredNames = readRolesFromRow(row, programa.roleColumns);
      const desiredKey = norm(desiredNames);

      // Si el cache ya coincide, no hay nada que hacer
      if (cache[userId] === desiredKey) continue;

      // Filtrar roles válidos; advertir sobre los que no existen en el servidor
      const unknown = desiredNames.filter(n => !roleByName.has(n));
      if (unknown.length) {
        log.warn({ msg: 'Roles invalidos en hoja (ignorados)', unknown, userId });
      }
      const validDesiredNames = desiredNames.filter(n => roleByName.has(n));

      try {
        const member = await guild.members.fetch(userId);
        const desiredSet = new Set(validDesiredNames);
        let added = 0;
        let removed = 0;

        // Agregar roles válidos que están en las columnas pero no tiene el miembro
        for (const roleName of validDesiredNames) {
          const role = roleByName.get(roleName);
          if (role && !member.roles.cache.has(role.id)) {
            await member.roles.add(role);
            added++;
          }
        }

        // Quitar roles gestionados que el miembro tiene pero NO están en sus columnas
        for (const [roleName, role] of managedRoles) {
          if (!desiredSet.has(roleName) && member.roles.cache.has(role.id)) {
            await member.roles.remove(role);
            removed++;
          }
        }

        cache[userId] = desiredKey;
        if (added > 0 || removed > 0) {
          log.info({
            msg: 'Roles sincronizados',
            user: member.user.tag,
            agregados: added,
            quitados: removed,
            rolesActuales: validDesiredNames,
          });
        }
      } catch (e) {
        log.error({ msg: 'Error sincronizando roles', userId, err: e.message });
      }
    }
  }

  client.once(Events.ClientReady, async () => {
    // Primer sync completo al arrancar (sin cache previo)
    for (const programa of Object.values(config.PROGRAMS)) {
      if (!programa.guildId || !programa.sheetId) continue;
      cacheByGuild[programa.guildId] = Object.create(null);
      previousManagedByGuild[programa.guildId] = new Set(programa.roles);

      try {
        await syncRoles(programa);
        logger.info({ msg: 'Sync inicial completado', programa: programa.name });
      } catch (e) {
        logger.error({ msg: 'Error en sync inicial', programa: programa.name, err: e.message });
      }
    }

    // Sincronizar cada 60 segundos para todos los programas
    setInterval(async () => {
      if (isSyncing) {
        logger.warn('Sync anterior aun en curso, saltando ciclo');
        return;
      }
      isSyncing = true;
      try {
        for (const programa of Object.values(config.PROGRAMS)) {
          if (!programa.guildId || !programa.sheetId) continue;
          await syncRoles(programa);
        }
      } finally {
        isSyncing = false;
      }
    }, CHECK_INTERVAL);

    logger.info('Modulo roles cargado (sync cada 60s, full sync)');
  });
}

module.exports = { setup, markVerified };
