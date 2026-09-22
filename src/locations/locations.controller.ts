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
  async findAll(@Req() req: AuthRequest): Promise<{ devices: DeviceLocation[] }> {
    const locations = await this.locations.findAll();
    return { devices: await this.access.filterTrackable(req.user, locations) };
  }

  @Get(':imei')
  async findOne(@Param('imei') imei: string, @Req() req: AuthRequest): Promise<DeviceLocation> {
    await this.access.assertTracking(req.user, imei);
    const location = await this.locations.findByImei(imei);
    if (!location) throw new NotFoundException(`No data received from device ${imei} yet`);
    return location;
  }
}
