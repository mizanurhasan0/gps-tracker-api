import { Transform } from 'class-transformer';
import { trim } from '../../auth/auth.dto';
import {
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateVehicleDto {
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

export class UpdateVehicleDto {
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
