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

module.exports = { getRows, appendRow, updateRow };
