import {
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(30)
  plate!: string;

  @IsNumberString({ no_symbols: true }, { message: 'imei must be digits only' })
  @Length(14, 17)
  imei!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  driverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  driverPhone?: string;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  plate?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'imei must be digits only' })
  @Length(14, 17)
  imei?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  driverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  driverPhone?: string;
}
