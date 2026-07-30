import { Injectable } from '@nestjs/common';
import type { GpsData } from '../interfaces/gps-data.interface';

@Injectable()
export class LocationService {
  private latestLocation: GpsData | null = null;

  setLatestLocation(data: GpsData): void {
    this.latestLocation = data;
  }

  getLatestLocation(): GpsData | null {
    return this.latestLocation;
  }
}
