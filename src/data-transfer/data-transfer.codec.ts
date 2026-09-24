import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { DataSet, FileFormat } from './data-transfer.dto';

export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_IMPORT_ROWS = 2_000;

export const headers: Record<DataSet, readonly string[]> = {
  vehicles: [
    'id', 'name', 'plate', 'imei', 'driverName', 'driverPhone', 'model', 'purchaseDate',
    'fitnessExpiresAt', 'licenseExpiresAt', 'status',
  ],
  routes: ['id', 'name', 'vehicleId', 'monthlyAmount', 'active'],
  stops: ['id', 'routeId', 'name', 'position'],
  drivers: [
    'id', 'name', 'phone', 'nid', 'address', 'joiningDate', 'monthlySalary', 'status',
    'vehicleId',
  ],
};

export type TransferRow = Record<string, string>;

function spreadsheetSafe(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function encodeCsv(dataset: DataSet, rows: Record<string, unknown>[]): Buffer {
  const columns = headers[dataset];
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function parseCsv(content: Buffer): string[][] {
  const source = content.toString('utf8').replace(/^\uFEFF/, '');
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      }
      else cell += char;
    } else if (afterQuote) {
      if (char === ',') {
        row.push(cell);
        cell = '';
        afterQuote = false;
      } else if (char === '\n' || (char === '\r' && source[i + 1] === '\n')) {
        if (char === '\r') i++;
        row.push(cell);
        if (row.some((value) => value !== '')) result.push(row);
        row = [];
        cell = '';
        afterQuote = false;
      } else throw new BadRequestException('CSV has characters after a closing quote');
    } else if (char === '"') {
      if (cell.length !== 0) throw new BadRequestException('CSV has a quote inside an unquoted field');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || (char === '\r' && source[i + 1] === '\n')) {
      if (char === '\r') i++;
      row.push(cell);
      if (row.some((value) => value !== '')) result.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new BadRequestException('CSV contains an unclosed quoted field');
  row.push(cell);
  if (row.some((value) => value !== '')) result.push(row);
  return result;
}

interface ExcelCell {
  value: unknown;
}
interface ExcelRow {
  cellCount: number;
  actualCellCount: number;
  getCell(column: number): ExcelCell;
  eachCell(options: { includeEmpty: boolean }, callback: (cell: ExcelCell) => void): void;
}
interface ExcelWorksheet {
  rowCount: number;
  actualRowCount: number;
  addRow(values: unknown[]): void;
  getRow(row: number): ExcelRow;
  eachRow(options: { includeEmpty: boolean }, callback: (row: ExcelRow) => void): void;
}
interface ExcelWorkbook {
  worksheets: ExcelWorksheet[];
  addWorksheet(name: string): ExcelWorksheet;
  xlsx: {
    load(data: Buffer): Promise<ExcelWorkbook>;
    writeBuffer(): Promise<ArrayBuffer>;
  };
}
interface ExcelJsApi {
  Workbook: new () => ExcelWorkbook;
}

function excelJs(): ExcelJsApi {
  try {
    // Kept lazy so CSV-only deployments start cleanly; install `exceljs` for Excel files.
    return require('exceljs') as ExcelJsApi;
  } catch {
    throw new ServiceUnavailableException('Excel support is unavailable; install the exceljs package');
  }
}

export async function encodeXlsx(
  dataset: DataSet,
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const api = excelJs();
  const columns = headers[dataset];
  const book = new api.Workbook();
  const sheet = book.addWorksheet(dataset);
  sheet.addRow([...columns]);
  for (const row of rows)
    sheet.addRow(columns.map((column) => spreadsheetSafe(row[column])));
  const output = await book.xlsx.writeBuffer();
  return Buffer.from(output);
}

function excelValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && 'richText' in value) {
    const rich = (value as { richText?: { text?: unknown }[] }).richText;
    return rich?.map((part) => String(part.text ?? '')).join('') ?? '';
  }
  if (typeof value === 'object' && 'hyperlink' in value && 'text' in value)
    return String((value as { text?: unknown }).text ?? '');
  throw new BadRequestException('XLSX contains an unsupported cell value');
}

function hasFormula(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    (('formula' in value && Boolean((value as { formula?: unknown }).formula)) ||
      ('sharedFormula' in value && Boolean((value as { sharedFormula?: unknown }).sharedFormula)));
}

export async function decodeRows(
  dataset: DataSet,
  format: FileFormat,
  content: Buffer,
): Promise<TransferRow[]> {
  if (!content.length) throw new BadRequestException('Import file is empty');
  if (content.length > MAX_IMPORT_BYTES)
    throw new BadRequestException(`Import file must not exceed ${MAX_IMPORT_BYTES} bytes`);
  let matrix: unknown[][];
  if (format === 'csv') matrix = parseCsv(content);
  else {
    const signature = content.subarray(0, 4).toString('hex');
    if (!['504b0304', '504b0506', '504b0708'].includes(signature))
      throw new BadRequestException('Invalid XLSX ZIP signature');
    const api = excelJs();
    const book = new api.Workbook();
    try {
      await book.xlsx.load(content);
    } catch {
      throw new BadRequestException('Invalid XLSX file');
    }
    if (book.worksheets.length !== 1)
      throw new BadRequestException('XLSX import must contain exactly one worksheet');
    const sheet = book.worksheets[0];
    if (sheet.rowCount > MAX_IMPORT_ROWS + 1 || sheet.actualRowCount > MAX_IMPORT_ROWS + 1)
      throw new BadRequestException(`Import cannot exceed ${MAX_IMPORT_ROWS} data rows`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (hasFormula(cell.value)) throw new BadRequestException('XLSX formulas are not allowed');
      });
    });
    matrix = [];
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      if (row.actualCellCount === 0) continue;
      const values: string[] = [];
      for (let column = 1; column <= row.cellCount; column++)
        values.push(excelValue(row.getCell(column).value));
      matrix.push(values);
    }
  }
  if (!matrix.length) throw new BadRequestException('Import file has no header row');
  if (matrix.length - 1 > MAX_IMPORT_ROWS)
    throw new BadRequestException(`Import cannot exceed ${MAX_IMPORT_ROWS} data rows`);
  const expected = headers[dataset];
  const actual = matrix[0].map(String);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
    throw new BadRequestException(`Headers must exactly match: ${expected.join(',')}`);
  return matrix.slice(1).map((values, rowIndex) => {
    if (values.length > expected.length)
      throw new BadRequestException(`Row ${rowIndex + 2} contains too many columns`);
    return Object.fromEntries(expected.map((column, index) => [column, String(values[index] ?? '').trim()]));
  });
}
