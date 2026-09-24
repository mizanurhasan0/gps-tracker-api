import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { User } from '../src/auth/auth.types';
import { encodeCsv } from '../src/data-transfer/data-transfer.codec';
import { DataTransferService } from '../src/data-transfer/data-transfer.service';
import { DatabaseService } from '../src/database/database.service';

const actor: User = {
  id: '78ca5f48-a81e-44a4-9c4f-b8af9e36bda5',
  name: 'Admin', phone: '01700000000', role: 'ADMIN', verified: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function input(name = 'Van') {
  const content = encodeCsv('vehicles', [{
    id: '', name, plate: 'DHAKA-1', imei: '12345678901234', driverName: '', driverPhone: '',
    model: '', purchaseDate: '', fitnessExpiresAt: '', licenseExpiresAt: '', status: 'RUNNING',
  }]);
  return { dataset: 'vehicles' as const, format: 'csv' as const, contentBase64: content.toString('base64') };
}

test('preview validates rows before issuing an actor-bound one-time token', async () => {
  const statements: string[] = [];
  const database = {
    run: async (sql: string) => { statements.push(sql); return { rowCount: 1 }; },
    transaction: async <T>(work: () => Promise<T>) => work(),
  } as unknown as DatabaseService;
  const service = new DataTransferService(database);
  const preview = await service.preview(actor, input());
  assert.equal(preview.rowCount, 1);
  assert.match(preview.sample[0].id, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    service.confirm({ ...actor, id: '62e1bc55-16c8-41b1-bb50-d29ce2ad8bea' }, preview.previewToken),
    BadRequestException,
  );
  assert.equal((await service.confirm(actor, preview.previewToken)).imported, 1);
  assert.equal(statements.length, 2);
  assert.match(statements[1], /INSERT INTO audit_logs/);
  await assert.rejects(service.confirm(actor, preview.previewToken), BadRequestException);
});

test('preview rejects formulas and invalid domain values', async () => {
  const service = new DataTransferService({} as DatabaseService);
  const formula = input('Safe');
  const formulaCsv = Buffer.from(formula.contentBase64, 'base64').toString('utf8').replace('Safe', '=HYPERLINK("bad")');
  formula.contentBase64 = Buffer.from(formulaCsv).toString('base64');
  await assert.rejects(service.preview(actor, formula), BadRequestException);
  const malformed = input();
  const decoded = Buffer.from(malformed.contentBase64, 'base64').toString('utf8').replace('12345678901234', 'not-an-imei');
  malformed.contentBase64 = Buffer.from(decoded).toString('base64');
  await assert.rejects(service.preview(actor, malformed), BadRequestException);
});
