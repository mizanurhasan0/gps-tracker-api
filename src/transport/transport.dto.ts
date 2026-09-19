import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsNumber,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { trim } from '../auth/auth.dto';
import { StudentProfileDto } from '../management/management.dto';
export class CreateRouteDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsUUID() vehicleId!: string;
  @IsInt() @Min(1) @Max(100_000_000) monthlyAmount!: number;
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(item => (typeof item === 'string' ? item.trim() : item))
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  stops!: string[];
}
export class RouteFareDto {
  @IsUUID() boardingStopId!: string;
  @IsUUID() dropoffStopId!: string;
  @IsInt() @Min(1) @Max(100_000_000) monthlyAmount!: number;
}
export class RouteFaresDto {
  @IsArray() @ArrayMaxSize(2450) @ValidateNested({ each: true }) @Type(() => RouteFareDto)
  fares!: RouteFareDto[];
}

export class PickupPointDto {
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsOptional() @IsInt() @Min(10) @Max(10000) enterRadiusMeters?: number;
  @IsOptional() @IsInt() @Min(11) @Max(20000) exitRadiusMeters?: number;
}
export class CreateServiceRequestDto extends StudentProfileDto {
  @IsOptional() @IsUUID() studentId?: string;
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  studentName!: string;
  @IsUUID() routeId!: string;
  @IsUUID() stopId!: string;
  @IsOptional() @IsUUID() dropoffStopId?: string | null;
}
export class NoteDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note!: string;
}
export class ComplaintDto {
  @IsUUID() subscriptionId!: string;
  @IsIn([
    'LATE_PICKUP',
    'DRIVER_BEHAVIOUR',
    'VEHICLE_SAFETY',
    'PAYMENT',
    'OTHER',
  ])
  category!: string;
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;
}
export class StopRequestDto {
  @IsUUID() subscriptionId!: string;
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
export class ComplaintReviewDto {
  @IsIn(['OPEN', 'RESOLVED']) status!: 'OPEN' | 'RESOLVED';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
