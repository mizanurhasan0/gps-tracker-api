import { Module } from '@nestjs/common';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';
import { ManagementController } from '../management/management.controller';
import { ManagementService } from '../management/management.service';
import { TELEGRAM_DELIVERY } from '../notifications/telegram-delivery.port';
import { TelegramDeliveryAdapter } from '../notifications/telegram-delivery.adapter';
import { TelegramModule } from '../telegram/telegram.module';
@Module({
  imports: [TelegramModule],
  controllers: [
    TransportController,
    PaymentsController,
    NotificationsController,
    ManagementController,
  ],
  providers: [
    TransportService,
    PaymentsService,
    NotificationsService,
    ManagementService,
    TelegramDeliveryAdapter,
    { provide: TELEGRAM_DELIVERY, useExisting: TelegramDeliveryAdapter },
  ],
  exports: [NotificationsService],
})
export class TransportModule {}
