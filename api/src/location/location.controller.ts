import { Controller, Get, Logger } from '@nestjs/common';
import { LocationService } from './location.service';

@Controller()
export class LocationController {
  private readonly logger = new Logger(LocationController.name);

  constructor(private readonly locationService: LocationService) {}

  @Get('location')
  getLocation(): Record<string, unknown> {
    this.logger.log('GET /location');

    const location = this.locationService.getLatestLocation();

    if (!location) {
      return { message: 'No location data available yet' };
    }

    return {
      imei: location.imei,
      latitude: location.latitude,
      longitude: location.longitude,
      speed: location.speed,
      timestamp: location.timestamp,
    };
  }

  @Get('health')
  getHealth(): Record<string, string> {
    return { status: 'ok' };
  }
}
