import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BACKUP_CONFIG, readBackupConfig } from './backup.config';
import { BackupMail } from './backup.mail';
import { BackupService } from './backup.service';

@Module({
  controllers: [BackupController],
  providers: [
    { provide: BACKUP_CONFIG, useFactory: () => readBackupConfig(process.env) },
    BackupMail,
    BackupService,
  ],
})
export class BackupModule {}
