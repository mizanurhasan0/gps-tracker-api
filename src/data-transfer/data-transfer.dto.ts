import { IsBase64, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const DATASETS = ['vehicles', 'routes', 'stops', 'drivers'] as const;
export type DataSet = (typeof DATASETS)[number];
export const FILE_FORMATS = ['csv', 'xlsx'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export class ImportPreviewDto {
  @IsIn(DATASETS)
  dataset!: DataSet;

  @IsIn(FILE_FORMATS)
  format!: FileFormat;

  @IsString()
  @IsBase64()
  @MaxLength(700_000)
  contentBase64!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  filename?: string;
}

export class ImportConfirmDto {
  @IsString()
  @MaxLength(128)
  previewToken!: string;
}
