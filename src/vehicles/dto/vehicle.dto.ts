import { Transform } from 'class-transformer';
import { trim } from '../../auth/auth.dto';
import {
  IsNumberString,
  IsIn,
  IsDateString,
  Matches,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class VehicleDetailsDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) model?: string;
  @IsOptional() @ValidateIf((_,value)=>value!=='') @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) purchaseDate?: string;
  @IsOptional() @ValidateIf((_,value)=>value!=='') @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) fitnessExpiresAt?: string;
  @IsOptional() @ValidateIf((_,value)=>value!=='') @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) licenseExpiresAt?: string;
  @IsOptional() @IsIn(['RUNNING','MAINTENANCE','INACTIVE']) status?: 'RUNNING' | 'MAINTENANCE' | 'INACTIVE';
}
export class CreateVehicleDto extends VehicleDetailsDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  plate!: string;

  @IsNumberString({ no_symbols: true }, { message: 'imei must be digits only' })
  @Length(14, 17)
  imei!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  driverName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  driverPhone?: string;
}

export class UpdateVehicleDto extends VehicleDetailsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  plate?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'imei must be digits only' })
  @Length(14, 17)
  imei?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  driverName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  driverPhone?: string;
}
