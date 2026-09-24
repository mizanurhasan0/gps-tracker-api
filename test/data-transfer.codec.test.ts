import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { decodeRows, encodeCsv, MAX_IMPORT_ROWS } from '../src/data-transfer/data-transfer.codec';

test('CSV round-trip preserves quoted values and neutralizes spreadsheet formula cells', async () => {
  const csv = encodeCsv('vehicles', [{
    id: 'c4486796-0e35-4ff3-a9ba-0188dccb3270', name: '=DANGEROUS()', plate: 'DHAKA,"1"',
    imei: '12345678901234', driverName: '', driverPhone: '', model: '', purchaseDate: '',
    fitnessExpiresAt: '', licenseExpiresAt: '', status: 'RUNNING',
  }]);
  const text = csv.toString('utf8');
  assert.match(text, /'=DANGEROUS\(\)/);
  assert.match(text, /"DHAKA,""1"""/);
  assert.equal((await decodeRows('vehicles', 'csv', csv))[0].plate, 'DHAKA,"1"');
});

test('CSV import enforces exact headers and row limit', async () => {
  await assert.rejects(
    decodeRows('vehicles', 'csv', Buffer.from('name,id\nvan,1\n')),
    BadRequestException,
  );
  const header = 'id,name,plate,imei,driverName,driverPhone,model,purchaseDate,fitnessExpiresAt,licenseExpiresAt,status';
  const tooMany = `${header}\n${Array(MAX_IMPORT_ROWS + 1).fill('x,,,,,,,,,,').join('\n')}`;
  await assert.rejects(decodeRows('vehicles', 'csv', Buffer.from(tooMany)), BadRequestException);
});

test('CSV parser rejects malformed quoted fields', async () => {
  const header = 'id,name,plate,imei,driverName,driverPhone,model,purchaseDate,fitnessExpiresAt,licenseExpiresAt,status';
  await assert.rejects(
    decodeRows('vehicles', 'csv', Buffer.from(`${header}\n,"never closes`)),
    BadRequestException,
  );
  await assert.rejects(
    decodeRows('vehicles', 'csv', Buffer.from(`${header}\n,un"quoted,,,,,,,,,`)),
    BadRequestException,
  );
  await assert.rejects(
    decodeRows('vehicles', 'csv', Buffer.from(`${header}\n,"closed"junk,,,,,,,,,`)),
    BadRequestException,
  );
});

test('XLSX import rejects non-ZIP content before loading ExcelJS', async () => {
  await assert.rejects(
    decodeRows('vehicles', 'xlsx', Buffer.from('not an xlsx file')),
    /Invalid XLSX ZIP signature/,
  );
});
