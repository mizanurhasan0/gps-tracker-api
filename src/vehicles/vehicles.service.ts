import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { Vehicle } from './vehicle.types';
@Injectable()
export class VehiclesService {
  constructor(private readonly db: DatabaseService) {}
  findAll(): Vehicle[] {
    return this.db.all('SELECT * FROM vehicles ORDER BY name');
  }
  findOne(id: string): Vehicle {
    const vehicle = this.db.get<Vehicle>(
      'SELECT * FROM vehicles WHERE id = ?',
      id,
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }
  create(input: CreateVehicleDto): Vehicle {
    this.assertImeiAvailable(input.imei);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO vehicles VALUES (?,?,?,?,?,?,?,?)',
      id,
      input.name.trim(),
      input.plate.trim(),
      input.imei,
      input.driverName?.trim() ?? null,
      input.driverPhone?.trim() ?? null,
      now,
      now,
    );
    return this.findOne(id);
  }
  update(id: string, input: UpdateVehicleDto): Vehicle {
    const existing = this.findOne(id);
    if (input.imei && input.imei !== existing.imei)
      this.assertImeiAvailable(input.imei);
    this.db.run(
      'UPDATE vehicles SET name=?,plate=?,imei=?,driverName=?,driverPhone=?,updatedAt=? WHERE id=?',
      input.name?.trim() ?? existing.name,
      input.plate?.trim() ?? existing.plate,
      input.imei ?? existing.imei,
      input.driverName?.trim() ?? existing.driverName ?? null,
      input.driverPhone?.trim() ?? existing.driverPhone ?? null,
      new Date().toISOString(),
      id,
    );
    return this.findOne(id);
  }
  remove(id: string): void {
    this.findOne(id);
    if (this.db.get('SELECT id FROM routes WHERE vehicleId = ?', id))
      throw new ConflictException(
        'This vehicle is assigned to a route and cannot be deleted',
      );
    this.db.run('DELETE FROM vehicles WHERE id = ?', id);
  }
  private assertImeiAvailable(imei: string): void {
    if (this.db.get('SELECT id FROM vehicles WHERE imei = ?', imei))
      throw new ConflictException('IMEI is already assigned');
  }
}
