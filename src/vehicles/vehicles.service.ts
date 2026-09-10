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
  findAll(): Promise<Vehicle[]> {
    return this.db.all<Vehicle>('SELECT * FROM vehicles ORDER BY name');
  }
  async findOne(id: string): Promise<Vehicle> {
    const vehicle = await this.db.get<Vehicle>(
      'SELECT * FROM vehicles WHERE id = $1',
      id
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }
  async create(input: CreateVehicleDto): Promise<Vehicle> {
    try {
      return await this.db.transaction(async () => {
        await this.assertImeiAvailable(input.imei);
        const id = randomUUID();
        const now = new Date().toISOString();
        await this.db.run(
          `INSERT INTO vehicles (id,name,plate,imei,"driverName","driverPhone","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          id,
          input.name.trim(),
          input.plate.trim(),
          input.imei,
          input.driverName?.trim() ?? null,
          input.driverPhone?.trim() ?? null,
          now,
          now
        );
        await this.saveDetails(id,input);
        await this.syncDriver(id,input);
        return this.findOne(id);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('IMEI is already assigned');
      if ((error as { code?: string }).code === '23503')
        throw new ConflictException(
          'This vehicle is assigned to a route and cannot be deleted'
        );
      throw error;
    }
  }
  async update(id: string, input: UpdateVehicleDto): Promise<Vehicle> {
    try {
      return await this.db.transaction(async () => {
        const existing = await this.findOne(id);
        if (input.imei && input.imei !== existing.imei)
          await this.assertImeiAvailable(input.imei);
        await this.db.run(
          'UPDATE vehicles SET name=$1,plate=$2,imei=$3,"driverName"=$4,"driverPhone"=$5,"updatedAt"=$6 WHERE id=$7',
          input.name?.trim() ?? existing.name,
          input.plate?.trim() ?? existing.plate,
          input.imei ?? existing.imei,
          input.driverName?.trim() ?? existing.driverName ?? null,
          input.driverPhone?.trim() ?? existing.driverPhone ?? null,
          new Date().toISOString(),
          id
        );
        await this.saveDetails(id,input);
        await this.syncDriver(id,input);
        return this.findOne(id);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('IMEI is already assigned');
      if ((error as { code?: string }).code === '23503')
        throw new ConflictException(
          'This vehicle is assigned to a route and cannot be deleted'
        );
      throw error;
    }
  }
  async remove(id: string): Promise<void> {
    try {
      return await this.db.transaction(async () => {
        await this.findOne(id);
        if (
          await this.db.get('SELECT id FROM routes WHERE "vehicleId" = $1', id)
        )
          throw new ConflictException(
            'This vehicle is assigned to a route and cannot be deleted'
          );
        await this.db.run('DELETE FROM vehicles WHERE id = $1', id);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('IMEI is already assigned');
      if ((error as { code?: string }).code === '23503')
        throw new ConflictException(
          'This vehicle is assigned to a route and cannot be deleted'
        );
      throw error;
    }
  }
  private async assertImeiAvailable(imei: string): Promise<void> {
    if (await this.db.get('SELECT id FROM vehicles WHERE imei = $1', imei))
      throw new ConflictException('IMEI is already assigned');
  }
  private async saveDetails(id:string,input:CreateVehicleDto|UpdateVehicleDto):Promise<void> {
    for(const field of ['model','purchaseDate','fitnessExpiresAt','licenseExpiresAt','status'] as const) {
      if(input[field]!==undefined && input[field]!==null)
        await this.db.run(`UPDATE vehicles SET "${field}"=$1 WHERE id=$2`,input[field],id);
    }
  }
  private async syncDriver(id:string,input:CreateVehicleDto|UpdateVehicleDto):Promise<void> {
    if(input.driverName===undefined && input.driverPhone===undefined) return;
    const vehicle=await this.findOne(id);
    const assigned=await this.db.get<{id:string}>('SELECT id FROM drivers WHERE "vehicleId"=$1',id);
    if(assigned) {
      await this.db.run('UPDATE drivers SET name=$1,phone=$2 WHERE id=$3',vehicle.driverName??'',vehicle.driverPhone??'',assigned.id);
    } else if(vehicle.driverName) {
      await this.db.run('INSERT INTO drivers(id,name,phone,"vehicleId","createdAt") VALUES($1,$2,$3,$4,$5)',randomUUID(),vehicle.driverName,vehicle.driverPhone??'',id,new Date().toISOString());
    }
  }
}
