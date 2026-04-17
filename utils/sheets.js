const { google } = require('googleapis');
const { logger } = require('./logger');

let googleClient;

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
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
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
    const stored = (row[matchCol] || '').trim();
    if (stored === matchVal || (matchVal && stored.startsWith(matchVal.slice(0, 15)))) {
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

module.exports = { getRows, appendRow, updateRow, deleteRowsByMatch, getSheetGid };
