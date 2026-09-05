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
  findAll(@Req() req: AuthRequest): { vehicles: Vehicle[] } {
    return {
      vehicles: this.vehicles
        .findAll()
        .filter(vehicle => this.access.canTrack(req.user, vehicle.imei)),
    };
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthRequest): Vehicle {
    const vehicle = this.vehicles.findOne(id);
    this.access.assertTracking(req.user, vehicle.imei);
    return vehicle;
  }

  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateVehicleDto): Vehicle {
    return this.vehicles.create(body);
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateVehicleDto): Vehicle {
    return this.vehicles.update(id, body);
  }

  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): void {
    this.vehicles.remove(id);
  }
}
