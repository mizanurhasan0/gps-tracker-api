import { Module } from '@nestjs/common';
import { appConfig } from '../../config/app.config';
import { RECOVERY_CONFIG } from './recovery.config';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { RECOVERY_MAIL, SmtpRecoveryMail } from './recovery.mail';
import { RecoveryMailWorker } from './recovery-mail.worker';

@Module({
  controllers: [RecoveryController],
  providers: [
    { provide: RECOVERY_CONFIG, useValue: appConfig.recovery },
    RecoveryService,
    SmtpRecoveryMail,
    RecoveryMailWorker,
    { provide: RECOVERY_MAIL, useExisting: SmtpRecoveryMail },
  ],
})
export class RecoveryModule {}
