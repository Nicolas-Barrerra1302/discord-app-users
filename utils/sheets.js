const { google } = require('googleapis');
const { logger } = require('./logger');

let googleClient;

// Encabezado de la hoja "Bajas": espeja A..G del tab principal + metadatos H/I.
const BAJAS_HEADER = ['username', 'visibleName', 'tag', 'userId', 'E', 'F', 'G', 'FechaBaja', 'Origen'];

// ── Utilidades compartidas ───────────────────────────
// Match de userId tolerante a pérdida de precisión (datos legacy guardados como número).
// Mismo criterio que deleteRowsByMatch / miembros.js, centralizado para reuso.
function matchesUserId(stored, id) {
  const s = (stored || '').trim();
  if (!id) return false;
  const idStr = String(id);
  return s === idStr || s.startsWith(idStr.slice(0, 15));
}

// Parseo de un rango A1 ("Tab!A2:G") → { sheetName, startRow }. Única implementación.
function parseRange(range) {
  const sheetName = range.split('!')[0];
  const cellPart = range.split('!')[1] || '';
  const startRow = parseInt(cellPart.match(/(\d+)/)?.[1] || '1', 10);
  return { sheetName, startRow };
}

// Reintento exponencial (1s/2s/4s, máx 3 intentos) para errores transitorios de Sheets.
async function withRetry(fn, { tries = 3, baseMs = 1000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const code = err?.code ?? err?.response?.status;
      const retriable =
        code === 429 || code === 500 || code === 502 || code === 503 ||
        code === 'ETIMEDOUT' || code === 'ECONNRESET';
      attempt++;
      if (!retriable || attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt - 1)));
    }
  }
}

async function getGoogleClient(credentialsPath) {
  if (googleClient) return googleClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  googleClient = await auth.getClient();
  return googleClient;
}

async function getSheetsApi(credentialsPath) {
  const auth = await getGoogleClient(credentialsPath);
  return google.sheets({ version: 'v4', auth });
}

async function getRows(credentialsPath, sheetId, range) {
  const sheets = await getSheetsApi(credentialsPath);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  }));
  return res.data.values || [];
}

async function appendRow(credentialsPath, sheetId, range, data) {
  const sheets = await getSheetsApi(credentialsPath);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [data] },
  });
  logger.info({ msg: 'Fila agregada a Google Sheets', sheetId });
}

// Cache de gid (sheet tab numeric id) por spreadsheet+nombre de tab.
// Se cachea la PROMESA, no el resultado, para single-flight ante llamadas concurrentes.
const sheetGidCache = new Map();

async function getSheetGid(credentialsPath, spreadsheetId, sheetName) {
  const key = `${spreadsheetId}:${sheetName}`;
  if (sheetGidCache.has(key)) return sheetGidCache.get(key);

  const promise = (async () => {
    const sheets = await getSheetsApi(credentialsPath);
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });
    const tab = (res.data.sheets || []).find(s => s.properties?.title === sheetName);
    if (!tab) {
      throw new Error(`No se encontro el tab "${sheetName}" en el spreadsheet ${spreadsheetId}`);
    }
    return tab.properties.sheetId;
  })();

  sheetGidCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    sheetGidCache.delete(key);
    throw err;
  }
}

async function deleteRowsByMatch(credentialsPath, spreadsheetId, range, matchCol, matchVal) {
  const rows = await getRows(credentialsPath, spreadsheetId, range);
  const sheetName = range.split('!')[0];
  const cellPart = range.split('!')[1] || '';
  const startRow = parseInt(cellPart.match(/(\d+)/)?.[1] || '1', 10);

  // Colectar todos los indices que matcheen, con tolerancia a perdida de precision
  const matchIndices = [];
  rows.forEach((row, i) => {
    if (matchesUserId(row[matchCol], matchVal)) {
      matchIndices.push(i);
    }
  });

  if (matchIndices.length === 0) return { deleted: 0 };

  const gid = await getSheetGid(credentialsPath, spreadsheetId, sheetName);
  const sheets = await getSheetsApi(credentialsPath);

  // Ordenar descendente: cada borrado desplaza filas siguientes hacia arriba
  matchIndices.sort((a, b) => b - a);
  const requests = matchIndices.map(i => ({
    deleteDimension: {
      range: {
        sheetId: gid,
        dimension: 'ROWS',
        startIndex: (startRow - 1) + i,
        endIndex: (startRow - 1) + i + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  return { deleted: matchIndices.length };
}

async function updateRow(credentialsPath, sheetId, range, matchCol, matchVal, updates) {
  const rows = await getRows(credentialsPath, sheetId, range);
  const rowIndex = rows.findIndex(row => row[matchCol] === matchVal);
  if (rowIndex === -1) return false;

  const sheets = await getSheetsApi(credentialsPath);
  const sheetName = range.split('!')[0];
  const cellPart = range.split('!')[1] || '';
  const startRow = parseInt(cellPart.match(/(\d+)/)?.[1] || '1', 10);

  for (const [col, val] of Object.entries(updates)) {
    const cellRange = `${sheetName}!${col}${startRow + rowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: cellRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[val]] },
    });
  }

  return true;
}

// ── Helpers nuevos (membresía: archivado, sync de nombres, barrido) ──

// Single-flight de ensureSheet por (spreadsheet, tab) para que dos archivados
// concurrentes no llamen addSheet dos veces.
const ensureSheetInFlight = new Map();

/**
 * Devuelve el gid numérico de `sheetName`, creando el tab si no existe. Idempotente.
 * Si `headerRow` se provee y el tab se crea, escribe la cabecera una vez en A1.
 */
async function ensureSheet(credentialsPath, spreadsheetId, sheetName, headerRow) {
  const key = `${spreadsheetId}:${sheetName}`;
  if (ensureSheetInFlight.has(key)) return ensureSheetInFlight.get(key);

  const promise = (async () => {
    // Camino rápido: el tab ya existe (gid cacheado por getSheetGid).
    try {
      return await getSheetGid(credentialsPath, spreadsheetId, sheetName);
    } catch (_) {
      // No existe → crear.
    }

    const sheets = await getSheetsApi(credentialsPath);
    let gid;
    try {
      const res = await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
      }));
      gid = res.data.replies[0].addSheet.properties.sheetId;
    } catch (err) {
      // Carrera: otro proceso ya lo creó ("already exists") → re-resolver.
      sheetGidCache.delete(key);
      return await getSheetGid(credentialsPath, spreadsheetId, sheetName);
    }

    if (headerRow && headerRow.length) {
      try {
        await withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headerRow] },
        }));
      } catch (e) {
        logger.warn({ msg: 'No se pudo escribir cabecera en tab nuevo', sheetName, err: e.message });
      }
    }

    // Re-sembrar la caché de gid para que getSheetGid acierte de inmediato.
    sheetGidCache.set(key, Promise.resolve(gid));
    logger.info({ msg: 'Tab creado', sheetName, spreadsheetId });
    return gid;
  })();

  ensureSheetInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    ensureSheetInFlight.delete(key);
  }
}

// Construye una fila de Bajas: copia A..G (ancho 7) + FechaBaja + Origen.
function buildBajasRow(row, fechaBaja, source) {
  const padded = [];
  for (let i = 0; i < 7; i++) padded.push(row[i] ?? '');
  padded.push(fechaBaja, source);
  return padded;
}

// Append batch de múltiples filas en un solo values.append. No-op si vacío.
async function batchAppendRows(credentialsPath, spreadsheetId, sheetName, rows) {
  if (!rows || rows.length === 0) return;
  const sheets = await getSheetsApi(credentialsPath);
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  }));
  logger.info({ msg: 'Filas agregadas (batch)', sheetName, count: rows.length });
}

// Escritura batch de celdas dispersas (values.batchUpdate), en chunks de ≤100. No-op si vacío.
async function batchUpdateValues(credentialsPath, spreadsheetId, data) {
  if (!data || data.length === 0) return;
  const sheets = await getSheetsApi(credentialsPath);
  const CHUNK = 100;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK);
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: chunk },
    }));
  }
}

/**
 * Ruta tiempo real (un usuario). Archiva (append-only) la(s) fila(s) del main que
 * matcheen `matchVal` en `matchCol` hacia la hoja `bajasSheetName`, preservando A..G,
 * y luego las borra del main. Orden crash-safe: append ANTES de delete.
 * Idempotencia/concurrencia se delegan a los guards en-proceso del caller (utils/locks.js).
 */
async function archiveRowByUserId(credentialsPath, spreadsheetId, mainRange, bajasSheetName, matchCol, matchVal, opts = {}) {
  const fechaBaja = opts.fechaBaja || new Date().toISOString();
  const source = opts.source || 'event';

  const rows = await getRows(credentialsPath, spreadsheetId, mainRange);
  const toArchive = rows.filter(row => matchesUserId(row[matchCol], matchVal));
  if (toArchive.length === 0) return { archived: 0, deleted: 0 };

  await ensureSheet(credentialsPath, spreadsheetId, bajasSheetName, BAJAS_HEADER);
  const bajasRows = toArchive.map(row => buildBajasRow(row, fechaBaja, source));
  await batchAppendRows(credentialsPath, spreadsheetId, bajasSheetName, bajasRows);

  const { deleted } = await deleteRowsByMatch(credentialsPath, spreadsheetId, mainRange, matchCol, matchVal);
  return { archived: bajasRows.length, deleted };
}

/**
 * Ruta barrido (batch, sin re-lecturas). Archiva todas las filas de `snapshotRows`
 * cuyo userId (col D, índice 3) esté en `userIds`, en un solo append a Bajas y un solo
 * batchUpdate de deleteDimension (índices del snapshot, descendente).
 */
async function archiveRowsByUserIds(credentialsPath, spreadsheetId, mainRange, bajasSheetName, snapshotRows, userIds, opts = {}) {
  const fechaBaja = opts.fechaBaja || new Date().toISOString();
  const source = opts.source || 'sweep';
  const idArr = userIds instanceof Set ? [...userIds] : (userIds || []);
  if (idArr.length === 0) return { archived: 0, deleted: 0 };

  const exactSet = new Set(idArr.map(String));
  const prefixSet = new Set(idArr.map(id => String(id).slice(0, 15)));

  const matchIndices = [];
  const bajasRows = [];
  snapshotRows.forEach((row, i) => {
    const stored = (row[3] || '').trim();
    const match = exactSet.has(stored) || (stored.length >= 15 && prefixSet.has(stored.slice(0, 15)));
    if (match) {
      matchIndices.push(i);
      bajasRows.push(buildBajasRow(row, fechaBaja, source));
    }
  });
  if (matchIndices.length === 0) return { archived: 0, deleted: 0 };

  const { sheetName, startRow } = parseRange(mainRange);
  await ensureSheet(credentialsPath, spreadsheetId, bajasSheetName, BAJAS_HEADER);
  await batchAppendRows(credentialsPath, spreadsheetId, bajasSheetName, bajasRows);

  const gid = await getSheetGid(credentialsPath, spreadsheetId, sheetName);
  const sheets = await getSheetsApi(credentialsPath);
  matchIndices.sort((a, b) => b - a); // descendente: borrar desde el final evita desplazamientos
  const requests = matchIndices.map(i => ({
    deleteDimension: {
      range: {
        sheetId: gid,
        dimension: 'ROWS',
        startIndex: (startRow - 1) + i,
        endIndex: (startRow - 1) + i + 1,
      },
    },
  }));
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));

  return { archived: bajasRows.length, deleted: matchIndices.length };
}

/**
 * Escritor de identidad tolerante a precisión (col D = userId, índice 3).
 * `updates` mapea letras de columna (A/B/C) a valor. Solo escribe esas columnas.
 * Reemplaza a updateRow en el código nuevo (updateRow usa match EXACTO y falla en filas legacy).
 * Devuelve false si no encuentra la fila.
 */
async function updateIdentityCells(credentialsPath, sheetId, range, userId, updates) {
  const rows = await getRows(credentialsPath, sheetId, range);
  const rowIndex = rows.findIndex(row => matchesUserId(row[3], userId));
  if (rowIndex === -1) return false;

  const { sheetName, startRow } = parseRange(range);
  const rowNum = startRow + rowIndex;
  const data = Object.entries(updates).map(([letter, val]) => ({
    range: `${sheetName}!${letter}${rowNum}`,
    values: [[val]],
  }));
  if (data.length === 0) return true;

  await batchUpdateValues(credentialsPath, sheetId, data);
  return true;
}

module.exports = {
  getRows,
  appendRow,
  updateRow,
  deleteRowsByMatch,
  getSheetGid,
  ensureSheet,
  archiveRowByUserId,
  archiveRowsByUserIds,
  batchUpdateValues,
  batchAppendRows,
  updateIdentityCells,
  matchesUserId,
  parseRange,
  withRetry,
  BAJAS_HEADER,
};
