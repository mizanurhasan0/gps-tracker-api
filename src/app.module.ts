import { Module } from '@nestjs/common';
import { TcpModule } from './tcp/tcp.module';
import { LocationModule } from './location/location.module';

@Module({
  imports: [TcpModule, LocationModule],
})
export class AppModule {}
