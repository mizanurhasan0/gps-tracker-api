import { Roles } from '../auth/auth.guard';
import { AccessService } from '../auth/access.service';
import { AuthRequest } from '../auth/auth.types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { VehiclesService } from './vehicles.service';
import type { Vehicle } from './vehicle.types';

@Controller('vehicles')
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async findAll(@Req() req: AuthRequest): Promise<{ vehicles: Vehicle[] }> {
    const vehicles = await this.vehicles.findAll();
    return { vehicles: await this.access.filterTrackable(req.user, vehicles) };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: AuthRequest): Promise<Vehicle> {
    const vehicle = await this.vehicles.findOne(id);
    await this.access.assertTracking(req.user, vehicle.imei);
    return vehicle;
  }

  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateVehicleDto): Promise<Vehicle> {
    return this.vehicles.create(body);
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateVehicleDto): Promise<Vehicle> {
    return this.vehicles.update(id, body);
  }

  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.vehicles.remove(id);
  }
}
