import { Module } from '@nestjs/common';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';
import { ManagementController } from '../management/management.controller';
import { ManagementService } from '../management/management.service';
import { TelegramModule } from '../telegram/telegram.module';
import { MessagingController } from '../messaging/messaging.controller';
import { MessagingService } from '../messaging/messaging.service';
@Module({
  imports: [TelegramModule],
  controllers: [
    TransportController,
    PaymentsController,
    NotificationsController,
    ManagementController,
    MessagingController,
  ],
  providers: [
    TransportService,
    PaymentsService,
    NotificationsService,
    ManagementService,
    MessagingService,
  ],
  exports: [NotificationsService],
})
export class TransportModule {}
