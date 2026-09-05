import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { LocationsService } from './locations.service';
import type { DeviceLocation } from './location.types';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  findAll(): { devices: DeviceLocation[] } {
    return { devices: this.locations.findAll() };
  }

  @Get(':imei')
  findOne(@Param('imei') imei: string): DeviceLocation {
    const location = this.locations.findByImei(imei);

    if (!location) {
      throw new NotFoundException(`No data received from device ${imei} yet`);
    }

    return location;
  }
}
