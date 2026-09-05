import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../auth/auth.dto';
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
export class CreateServiceRequestDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  studentName!: string;
  @IsUUID() routeId!: string;
  @IsUUID() stopId!: string;
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
