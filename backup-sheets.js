/**
 * Script one-off: duplica cada tab `miembros_discord` a `miembros_discord_backup_<fecha>`
 * dentro del MISMO spreadsheet (request duplicateSheet, permitido bajo scope spreadsheets,
 * sin Drive). Correr ANTES del primer barrido real:  node backup-sheets.js
 */
require('dotenv').config();
const { google } = require('googleapis');
const config = require('./config');

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;

async function getSheetsApi() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function backupTab(spreadsheetId, tabName) {
  const sheets = await getSheetsApi();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const src = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
  if (!src) {
    console.log(`  [${spreadsheetId}] No existe el tab "${tabName}", omitiendo`);
    return;
  }
  const newName = `${tabName}_backup_${stamp()}`;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ duplicateSheet: { sourceSheetId: src.properties.sheetId, newSheetName: newName } }],
    },
  });
  console.log(`  [${spreadsheetId}] Respaldo creado: ${newName}`);
}

async function main() {
  console.log('=== Respaldo de tabs miembros_discord ===');
  const seen = new Set();
  for (const programa of Object.values(config.PROGRAMS)) {
    if (!programa.sheetId) continue;
    const tabName = programa.sheetRange.split('!')[0];
    const key = `${programa.sheetId}:${tabName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`\nPrograma ${programa.name} (${programa.sheetId})`);
    await backupTab(programa.sheetId, tabName);
  }
  console.log('\n=== Respaldo completado ===');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
