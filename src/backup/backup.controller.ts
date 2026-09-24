import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { BackupService } from './backup.service';

@Controller('admin/backups')
@Roles('ADMIN')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get('status')
  status() {
    return this.backups.status();
  }

  @Post()
  @HttpCode(202)
  run() {
    return this.backups.runManual();
  }
}
