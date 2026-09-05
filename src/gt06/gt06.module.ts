import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { Gt06Server } from './gt06.server';

@Module({
  imports: [LocationsModule, RealtimeModule],
  providers: [Gt06Server],
})
export class Gt06Module {}
