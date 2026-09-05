import { AccessService } from '../auth/access.service';
import { AuthRequest } from '../auth/auth.types';
import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { LocationsService } from './locations.service';
import type { DeviceLocation } from './location.types';

@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  findAll(@Req() req: AuthRequest): { devices: DeviceLocation[] } {
    return {
      devices: this.locations
        .findAll()
        .filter(location => this.access.canTrack(req.user, location.imei)),
    };
  }

  @Get(':imei')
  findOne(
    @Param('imei') imei: string,
    @Req() req: AuthRequest,
  ): DeviceLocation {
    this.access.assertTracking(req.user, imei);
    const location = this.locations.findByImei(imei);

    if (!location) {
      throw new NotFoundException(`No data received from device ${imei} yet`);
    }

    return location;
  }
}
