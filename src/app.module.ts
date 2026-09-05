import { SecurityModule } from './auth/security.module';
import { TransportModule } from './transport/transport.module';
import { Module } from '@nestjs/common';
import { Gt06Module } from './gt06/gt06.module';
import { HealthController } from './health/health.controller';
import { LocationsModule } from './locations/locations.module';
import { RealtimeModule } from './realtime/realtime.module';
import { VehiclesModule } from './vehicles/vehicles.module';

@Module({
  imports: [
    SecurityModule,
    TransportModule,
    LocationsModule,
    VehiclesModule,
    RealtimeModule,
    Gt06Module,
  ],
  controllers: [HealthController],
})
export class AppModule {}
