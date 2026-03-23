/**
 * Script de limpieza: elimina filas duplicadas por userId en miembros_discord.
 * Para cada userId duplicado, conserva la fila que tenga más roles.
 * Ejecutar una vez: node cleanup-duplicates.js
 */
require('dotenv').config();
const { google } = require('googleapis');

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;

async function getSheetsApi() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function getSheetId(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

async function cleanupSheet(spreadsheetId, range, rolColCount) {
  const sheets = await getSheetsApi();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];

  console.log(`\nSheet ${spreadsheetId} - ${range}`);
  console.log(`Total filas: ${rows.length}`);

  // Agrupar filas por userId (columna D, índice 3)
  const byUser = new Map();
  for (let i = 0; i < rows.length; i++) {
    const userId = rows[i]?.[3];
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push({ index: i, row: rows[i] });
  }

  // Encontrar filas duplicadas a eliminar
  const rowsToDelete = [];
  for (const [userId, entries] of byUser) {
    if (entries.length <= 1) continue;

    console.log(`  Duplicado: userId=${userId} (${entries.length} filas)`);

    // Elegir la fila con más roles (columnas de rol no vacías)
    entries.sort((a, b) => {
      const rolesA = a.row.slice(4, 4 + rolColCount).filter(v => v && v.trim()).length;
      const rolesB = b.row.slice(4, 4 + rolColCount).filter(v => v && v.trim()).length;
      return rolesB - rolesA; // más roles primero
    });

    // Conservar la primera (más roles), marcar el resto para eliminar
    const kept = entries[0];
    console.log(`    Conservando fila ${kept.index + 2} (roles: ${kept.row.slice(4, 4 + rolColCount).filter(v => v && v.trim()).join(', ') || 'ninguno'})`);
    for (let j = 1; j < entries.length; j++) {
      console.log(`    Eliminando fila ${entries[j].index + 2}`);
      rowsToDelete.push(entries[j].index);
    }
  }

  if (rowsToDelete.length === 0) {
    console.log('  Sin duplicados.');
    return;
  }

  // Eliminar filas de abajo hacia arriba para que los índices no se desplacen
  const sheetName = range.split('!')[0];
  const cellPart = range.split('!')[1] || '';
  const startRow = parseInt(cellPart.match(/(\d+)/)?.[1] || '1', 10);
  const numericSheetId = await getSheetId(sheets, spreadsheetId, sheetName);

  if (numericSheetId === null) {
    console.log(`  ERROR: No se encontró la pestaña "${sheetName}"`);
    return;
  }

  // Ordenar de mayor a menor para borrar desde el final
  rowsToDelete.sort((a, b) => b - a);

  const requests = rowsToDelete.map(idx => ({
    deleteDimension: {
      range: {
        sheetId: numericSheetId,
        dimension: 'ROWS',
        startIndex: startRow - 1 + idx,     // 0-based
        endIndex: startRow - 1 + idx + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log(`  ${rowsToDelete.length} filas duplicadas eliminadas.`);
}

async function main() {
  console.log('=== Limpieza de duplicados en miembros_discord ===');

  // Programa A: columnas E, F, G (3 columnas de roles)
  await cleanupSheet(
    process.env.SHEET_ID_A,
    'miembros_discord!A2:G',
    3
  );

  // Programa B (Creeser): columna E (1 columna de rol)
  await cleanupSheet(
    process.env.SHEET_ID_B,
    'miembros_discord!A2:E',
    1
  );

  console.log('\n=== Limpieza completada ===');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
