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
} from '@nestjs/common';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { VehiclesService } from './vehicles.service';
import type { Vehicle } from './vehicle.types';

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  findAll(): { vehicles: Vehicle[] } {
    return { vehicles: this.vehicles.findAll() };
  }

  @Get(':id')
  findOne(@Param('id') id: string): Vehicle {
    return this.vehicles.findOne(id);
  }

  @Post()
  create(@Body() body: CreateVehicleDto): Vehicle {
    return this.vehicles.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateVehicleDto): Vehicle {
    return this.vehicles.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): void {
    this.vehicles.remove(id);
  }
}
