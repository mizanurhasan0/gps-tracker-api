import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { AuthRequest } from '../auth/auth.types';
import { DataTransferService } from './data-transfer.service';
import {
  DATASETS,
  DataSet,
  FILE_FORMATS,
  FileFormat,
  ImportConfirmDto,
  ImportPreviewDto,
} from './data-transfer.dto';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

@Roles('ADMIN')
@Controller('admin/data-transfer')
export class DataTransferController {
  constructor(private readonly service: DataTransferService) {}

  @Get('export')
  async export(
    @Req() req: AuthRequest,
    @Query('dataset') dataset: DataSet,
    @Query('format') format: FileFormat,
    @Res() response: HttpResponse,
  ): Promise<void> {
    if (!DATASETS.includes(dataset) || !FILE_FORMATS.includes(format)) {
      response.status(400).json({ message: 'dataset and format must be supported values' });
      return;
    }
    const file = await this.service.export(dataset, format, req.user);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(file.content);
  }

  @Post('import/preview')
  preview(@Req() req: AuthRequest, @Body() input: ImportPreviewDto) {
    return this.service.preview(req.user, input);
  }

  @Post('import/confirm')
  confirm(@Req() req: AuthRequest, @Body() input: ImportConfirmDto) {
    return this.service.confirm(req.user, input.previewToken);
  }
}
