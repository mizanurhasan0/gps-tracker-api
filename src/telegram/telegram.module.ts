import { Module } from '@nestjs/common';
import { TELEGRAM_DELIVERY } from '../notifications/telegram-delivery.port';
import { TelegramController } from './telegram.controller';
import { TelegramPollingService } from './telegram-polling.service';
import { TelegramService } from './telegram.service';

@Module({
  controllers: [TelegramController],
  providers: [
    TelegramService,
    TelegramPollingService,
    { provide: TELEGRAM_DELIVERY, useExisting: TelegramService },
  ],
  exports: [TelegramService, TELEGRAM_DELIVERY],
})
export class TelegramModule {}
