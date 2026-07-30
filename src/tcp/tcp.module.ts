import { Module } from '@nestjs/common';
import { TcpServer } from './tcp.server';
import { Gt06Parser } from './gt06.parser';
import { LocationModule } from '../location/location.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [LocationModule, GatewayModule],
  providers: [TcpServer, Gt06Parser],
  exports: [Gt06Parser],
})
export class TcpModule {}
