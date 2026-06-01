/**
 * Guards de concurrencia en-proceso, compartidos entre cleanup.js (archivado en
 * tiempo real) y sweep.js (barrido diario). Todos son in-memory: NO sobreviven a
 * un reinicio del proceso (ver decisión de Bajas append-only en el plan).
 */

// Serializa el archivado del MISMO usuario entre evento y barrido. Clave: `${guildId}:${userId}`.
const pendingArchive = new Set();

// Guilds con un barrido en curso (snapshot vivo del tab principal). Mientras esté
// presente, ningún otro actor debe BORRAR/desplazar filas de ese guild.
const activeSweeps = new Set();

// Bajas en tiempo real recibidas DURANTE un barrido; el barrido las drena al terminar.
// Map<guildId, Set<userId>>.
const deferredArchives = new Map();

function archiveKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function isArchiving(guildId, userId) {
  return pendingArchive.has(archiveKey(guildId, userId));
}

function markArchiving(guildId, userId) {
  pendingArchive.add(archiveKey(guildId, userId));
}

function clearArchiving(guildId, userId) {
  pendingArchive.delete(archiveKey(guildId, userId));
}

// ¿Hay algún archivado en curso para este guild? (cualquier userId)
function hasPendingArchiveForGuild(guildId) {
  const prefix = `${guildId}:`;
  for (const k of pendingArchive) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

function markSweep(guildId) {
  activeSweeps.add(guildId);
}

function clearSweep(guildId) {
  activeSweeps.delete(guildId);
}

function isSweepActive(guildId) {
  return activeSweeps.has(guildId);
}

function enqueueDeferredArchive(guildId, userId) {
  if (!deferredArchives.has(guildId)) deferredArchives.set(guildId, new Set());
  deferredArchives.get(guildId).add(userId);
}

// Devuelve los userId encolados para `guildId` y limpia la cola.
function drainDeferredArchives(guildId) {
  const set = deferredArchives.get(guildId);
  if (!set || set.size === 0) return [];
  deferredArchives.delete(guildId);
  return [...set];
}

module.exports = {
  pendingArchive,
  activeSweeps,
  deferredArchives,
  isArchiving,
  markArchiving,
  clearArchiving,
  hasPendingArchiveForGuild,
  markSweep,
  clearSweep,
  isSweepActive,
  enqueueDeferredArchive,
  drainDeferredArchives,
};
