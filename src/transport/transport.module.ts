import { Module } from '@nestjs/common';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';
@Module({
  controllers: [
    TransportController,
    PaymentsController,
    NotificationsController,
  ],
  providers: [TransportService, PaymentsService, NotificationsService],
})
export class TransportModule {}
