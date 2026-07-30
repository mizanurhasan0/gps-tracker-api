import { Module } from '@nestjs/common';
import { GpsGateway } from './gps.gateway';

@Module({
  providers: [GpsGateway],
  exports: [GpsGateway],
})
export class GatewayModule {}
