import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { decodeRows, encodeCsv, encodeXlsx, TransferRow } from './data-transfer.codec';
import { DataSet, FileFormat, ImportPreviewDto } from './data-transfer.dto';

interface Preview {
  actorId: string;
  dataset: DataSet;
  rows: TransferRow[];
  expiresAt: number;
}
interface ExportedFile {
  content: Buffer;
  contentType: string;
  filename: string;
}

const TOKEN_TTL_MS = 10 * 60_000;
const MAX_PREVIEWS = 10;
const MAX_EXPORT_ROWS = 20_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const phonePattern = /^\+?[0-9]{7,15}$/;
const imeiPattern = /^\d{14,17}$/;

@Injectable()
export class DataTransferService {
  private readonly previews = new Map<string, Preview>();

  constructor(private readonly db: DatabaseService) {}

  async export(dataset: DataSet, format: FileFormat, actor: User): Promise<ExportedFile> {
    const rows = await this.exportRows(dataset);
    if (rows.length > MAX_EXPORT_ROWS)
      throw new BadRequestException(
        `Export cannot exceed ${MAX_EXPORT_ROWS} rows; narrow or archive the dataset first`,
      );
    const content = format === 'csv' ? encodeCsv(dataset, rows) : await encodeXlsx(dataset, rows);
    await this.audit(actor.id, 'DATA_EXPORT', dataset, `${format}:${rows.length}`);
    return {
      content,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${dataset}-${new Date().toISOString().slice(0, 10)}.${format}`,
    };
  }

  async preview(actor: User, input: ImportPreviewDto) {
    this.prunePreviews();
    const content = Buffer.from(input.contentBase64, 'base64');
    const rows = await decodeRows(input.dataset, input.format, content);
    if (!rows.length) throw new BadRequestException('Import file has no data rows');
    const normalized = rows.map((row, index) => this.validate(input.dataset, row, index + 2));
    const ids = normalized.map((row) => row.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Import contains duplicate IDs');
    if (this.previews.size >= MAX_PREVIEWS)
      throw new BadRequestException('Too many pending imports; try again later');
    const previewToken = randomBytes(32).toString('base64url');
    this.previews.set(previewToken, {
      actorId: actor.id,
      dataset: input.dataset,
      rows: normalized,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return {
      previewToken,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      dataset: input.dataset,
      rowCount: normalized.length,
      sample: normalized.slice(0, 10),
    };
  }

  async confirm(actor: User, previewToken: string) {
    this.prunePreviews();
    const preview = this.previews.get(previewToken);
    if (!preview || preview.actorId !== actor.id)
      throw new BadRequestException('Preview token is invalid or expired');
    this.previews.delete(previewToken);
    try {
      await this.db.transaction(async () => {
        for (const row of preview.rows) await this.upsert(preview.dataset, row);
        await this.audit(
          actor.id,
          'DATA_IMPORT',
          preview.dataset,
          `rows:${preview.rows.length}`,
        );
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new ConflictException('Import conflicts with existing unique data');
      if (code === '23503') throw new BadRequestException('Import references a missing related record');
      if (code === '23514' || code === '23502')
        throw new BadRequestException('Import violates a database validation rule');
      throw error;
    }
    return { dataset: preview.dataset, imported: preview.rows.length };
  }

  private exportRows(dataset: DataSet): Promise<Record<string, unknown>[]> {
    switch (dataset) {
      case 'vehicles':
        return this.db.all(`SELECT id,name,plate,imei,"driverName","driverPhone",model,"purchaseDate","fitnessExpiresAt","licenseExpiresAt",status FROM vehicles ORDER BY name,id LIMIT 20001`);
      case 'routes':
        return this.db.all(`SELECT id,name,"vehicleId","monthlyAmount",active FROM routes ORDER BY name,id LIMIT 20001`);
      case 'stops':
        return this.db.all(`SELECT id,"routeId",name,position FROM stops ORDER BY "routeId",position,id LIMIT 20001`);
      case 'drivers':
        return this.db.all(`SELECT id,name,phone,nid,address,"joiningDate","monthlySalary",status,"vehicleId" FROM drivers ORDER BY name,id LIMIT 20001`);
    }
  }

  private validate(dataset: DataSet, row: TransferRow, line: number): TransferRow {
    const fail = (message: string): never => {
      throw new BadRequestException(`Row ${line}: ${message}`);
    };
    const required = (...names: string[]) => {
      for (const name of names) if (!row[name]) fail(`${name} is required`);
    };
    for (const [field, value] of Object.entries(row)) {
      if (value.length > 500) fail(`${field} is too long`);
      if (value.includes('\0')) fail(`${field} contains an invalid control character`);
      const isInternationalPhone = (field === 'phone' || field === 'driverPhone') && /^\+\d+$/.test(value);
      if (!isInternationalPhone && /^[\t\r ]*[=+\-@]/.test(value))
        fail(`${field} begins with a spreadsheet formula marker`);
    }
    if (row.id && !uuidPattern.test(row.id)) fail('id must be a UUID');
    row.id ||= randomUUID();
    if (dataset === 'vehicles') {
      required('name', 'plate', 'imei');
      if (!imeiPattern.test(row.imei)) fail('imei must contain 14 to 17 digits');
      if (row.driverPhone && !phonePattern.test(row.driverPhone)) fail('driverPhone is invalid');
      for (const field of ['purchaseDate', 'fitnessExpiresAt', 'licenseExpiresAt'])
        if (row[field] && !this.validDate(row[field])) fail(`${field} must be a real YYYY-MM-DD date`);
      row.status ||= 'RUNNING';
      if (!['RUNNING', 'MAINTENANCE', 'INACTIVE'].includes(row.status)) fail('status is invalid');
    } else if (dataset === 'routes') {
      required('name', 'vehicleId', 'monthlyAmount');
      if (!uuidPattern.test(row.vehicleId)) fail('vehicleId must be a UUID');
      this.integer(row, 'monthlyAmount', line, 1);
      row.active ||= '1';
      if (!['0', '1'].includes(row.active)) fail('active must be 0 or 1');
    } else if (dataset === 'stops') {
      required('routeId', 'name', 'position');
      if (!uuidPattern.test(row.routeId)) fail('routeId must be a UUID');
      this.integer(row, 'position', line, 0);
    } else {
      required('name', 'phone');
      if (!phonePattern.test(row.phone)) fail('phone is invalid');
      if (row.vehicleId && !uuidPattern.test(row.vehicleId)) fail('vehicleId must be a UUID');
      if (row.joiningDate && !this.validDate(row.joiningDate)) fail('joiningDate must be a real YYYY-MM-DD date');
      row.monthlySalary ||= '0';
      this.integer(row, 'monthlySalary', line, 0);
      row.status ||= 'ACTIVE';
      if (!['ACTIVE', 'LEAVE', 'INACTIVE'].includes(row.status)) fail('status is invalid');
    }
    return row;
  }

  private integer(row: TransferRow, field: string, line: number, minimum: number): void {
    if (!/^\d+$/.test(row[field]) || Number(row[field]) < minimum || !Number.isSafeInteger(Number(row[field])))
      throw new BadRequestException(`Row ${line}: ${field} must be an integer of at least ${minimum}`);
  }

  private validDate(value: string): boolean {
    if (!datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }

  private async upsert(dataset: DataSet, row: TransferRow): Promise<void> {
    const timestamp = new Date().toISOString();
    if (dataset === 'vehicles') {
      await this.db.run(
        `INSERT INTO vehicles(id,name,plate,imei,"driverName","driverPhone","createdAt","updatedAt",model,"purchaseDate","fitnessExpiresAt","licenseExpiresAt",status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,plate=EXCLUDED.plate,imei=EXCLUDED.imei,"driverName"=EXCLUDED."driverName","driverPhone"=EXCLUDED."driverPhone","updatedAt"=EXCLUDED."updatedAt",model=EXCLUDED.model,"purchaseDate"=EXCLUDED."purchaseDate","fitnessExpiresAt"=EXCLUDED."fitnessExpiresAt","licenseExpiresAt"=EXCLUDED."licenseExpiresAt",status=EXCLUDED.status`,
        row.id, row.name, row.plate, row.imei, row.driverName || null, row.driverPhone || null,
        timestamp, row.model, row.purchaseDate, row.fitnessExpiresAt, row.licenseExpiresAt, row.status,
      );
    } else if (dataset === 'routes') {
      await this.db.run(
        `INSERT INTO routes(id,name,"vehicleId","monthlyAmount",active) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,"vehicleId"=EXCLUDED."vehicleId","monthlyAmount"=EXCLUDED."monthlyAmount",active=EXCLUDED.active`,
        row.id, row.name, row.vehicleId, Number(row.monthlyAmount), Number(row.active),
      );
    } else if (dataset === 'stops') {
      await this.db.run(
        `INSERT INTO stops(id,"routeId",name,position) VALUES($1,$2,$3,$4)
         ON CONFLICT(id) DO UPDATE SET "routeId"=EXCLUDED."routeId",name=EXCLUDED.name,position=EXCLUDED.position`,
        row.id, row.routeId, row.name, Number(row.position),
      );
    } else {
      await this.db.run(
        `INSERT INTO drivers(id,name,phone,nid,address,"joiningDate","monthlySalary",status,"vehicleId","createdAt")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,nid=EXCLUDED.nid,address=EXCLUDED.address,"joiningDate"=EXCLUDED."joiningDate","monthlySalary"=EXCLUDED."monthlySalary",status=EXCLUDED.status,"vehicleId"=EXCLUDED."vehicleId"`,
        row.id, row.name, row.phone, row.nid, row.address, row.joiningDate,
        Number(row.monthlySalary), row.status, row.vehicleId || null, timestamp,
      );
    }
  }

  private audit(actorId: string, action: string, entityId: string, note: string): Promise<void> {
    return this.db.run(
      `INSERT INTO audit_logs(id,"actorId",action,"entityId",note,"createdAt") VALUES($1,$2,$3,$4,$5,$6)`,
      randomUUID(), actorId, action, entityId, note, new Date().toISOString(),
    ).then(() => undefined);
  }

  private prunePreviews(): void {
    const current = Date.now();
    for (const [token, preview] of this.previews)
      if (preview.expiresAt <= current) this.previews.delete(token);
  }
}
