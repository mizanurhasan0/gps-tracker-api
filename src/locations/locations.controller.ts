import { AccessService } from '../auth/access.service';
import { AuthRequest } from '../auth/auth.types';
import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { LocationsService } from './locations.service';
import type { DeviceLocation } from './location.types';

@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: AccessService
  ) {}

  @Get()
  async findAll(
    @Req() req: AuthRequest
  ): Promise<{ devices: DeviceLocation[] }> {
    const locations = await this.locations.findAll();
    const allowed = await Promise.all(
      locations.map((location) => this.access.canTrack(req.user, location.imei))
    );
    return { devices: locations.filter((_location, index) => allowed[index]) };
  }

  @Get(':imei')
  async findOne(
    @Param('imei') imei: string,
    @Req() req: AuthRequest
  ): Promise<DeviceLocation> {
    await this.access.assertTracking(req.user, imei);
    const location = await this.locations.findByImei(imei);
    if (!location)
      throw new NotFoundException(`No data received from device ${imei} yet`);
    return location;
  }
}
