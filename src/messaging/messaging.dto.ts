import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { trim } from '../auth/auth.dto';

/** Accepts `?vehicleIds=a,b` and repeated `?vehicleIds=a&vehicleIds=b`. */
const commaList = ({ value }: { value: unknown }) =>
  typeof value === 'string' || Array.isArray(value)
    ? [value]
        .flat()
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
        .map((item) => (typeof item === 'string' ? item.trim() : item))
    : value;
// Null must fail validation on optional fields instead of clearing them.
const present = (_: object, value: unknown) => value !== undefined;

export class MessageTemplateDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) title!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}
export class UpdateMessageTemplateDto {
  @ValidateIf(present) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) title?: string;
  @ValidateIf(present) @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) body?: string;
}
export class TelegramRecipientsQueryDto {
  @Transform(commaList) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) vehicleIds!: string[];
}
export class TelegramMessageDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) vehicleIds!: string[];
  @ValidateIf(present) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @ArrayUnique() @IsUUID('all', { each: true }) guardianIds?: string[];
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) body!: string;
  @IsOptional() @IsUUID() templateId?: string | null;
  @IsUUID() requestId!: string;
}
export class TelegramMessageListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}
