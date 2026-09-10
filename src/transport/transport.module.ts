import { Module } from '@nestjs/common';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';
import { ManagementController } from '../management/management.controller';
import { ManagementService } from '../management/management.service';
@Module({
  controllers: [
    TransportController,
    PaymentsController,
    NotificationsController,
    ManagementController,
  ],
  providers: [TransportService, PaymentsService, NotificationsService, ManagementService],
})
export class TransportModule {}
