import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { appConfig } from '../config/app.config';
import { JsonStore } from '../common/json-store';
import type { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import type { Vehicle } from './vehicle.types';

@Injectable()
export class VehiclesService implements OnModuleInit {
  private readonly logger = new Logger(VehiclesService.name);
  private readonly store = new JsonStore<Vehicle[]>(
    appConfig.storage.dataDir,
    'vehicles.json',
  );
  private vehicles: Vehicle[] = [];

  onModuleInit(): void {
    this.vehicles = this.store.read([]).filter(vehicle => vehicle?.id);
    this.logger.log(`Loaded ${this.vehicles.length} vehicle(s)`);
  }

  findAll(): Vehicle[] {
    return [...this.vehicles];
  }

  findOne(id: string): Vehicle {
    const vehicle = this.vehicles.find(item => item.id === id);

    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }

    return vehicle;
  }

  create(input: CreateVehicleDto): Vehicle {
    this.assertImeiAvailable(input.imei);

    const now = new Date().toISOString();
    const vehicle: Vehicle = {
      id: randomUUID(),
      name: input.name.trim(),
      plate: input.plate.trim(),
      imei: input.imei.trim(),
      driverName: input.driverName?.trim(),
      driverPhone: input.driverPhone?.trim(),
      createdAt: now,
      updatedAt: now,
    };

    this.vehicles.push(vehicle);
    this.persist();

    return vehicle;
  }

  update(id: string, input: UpdateVehicleDto): Vehicle {
    const existing = this.findOne(id);

    if (input.imei && input.imei !== existing.imei) {
      this.assertImeiAvailable(input.imei);
    }

    const updated: Vehicle = {
      ...existing,
      name: input.name?.trim() ?? existing.name,
      plate: input.plate?.trim() ?? existing.plate,
      imei: input.imei?.trim() ?? existing.imei,
      driverName: input.driverName?.trim() ?? existing.driverName,
      driverPhone: input.driverPhone?.trim() ?? existing.driverPhone,
      updatedAt: new Date().toISOString(),
    };

    this.vehicles = this.vehicles.map(item =>
      item.id === id ? updated : item,
    );
    this.persist();

    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.vehicles = this.vehicles.filter(item => item.id !== id);
    this.persist();
  }

  private assertImeiAvailable(imei: string): void {
    if (this.vehicles.some(vehicle => vehicle.imei === imei)) {
      throw new ConflictException(`IMEI ${imei} is already assigned`);
    }
  }

  private persist(): void {
    this.store.write(this.vehicles);
  }
}
