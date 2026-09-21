import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../auth/auth.dto';
export class PaymentEvidenceDto {
  @IsOptional() @Transform(trim) @Matches(/^(?:|[A-Za-z0-9][A-Za-z0-9._:/-]{0,99})$/)
  transactionId?: string;
  @IsOptional() @IsString() @MaxLength(450000)
  @Matches(/^(?:|data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2})$/)
  evidenceImageUrl?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  transactionInfo?: string;
}
export class PaymentSubmissionDto extends PaymentEvidenceDto {
  @IsUUID() billId!: string;
  @Matches(/^[A-Za-z0-9_-]{1,80}$/) method!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) senderNumber!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) recipientNumber!: string;
  // All monetary amounts are integer poisha, never binary floating-point taka.
  @IsInt() @Min(1) @Max(100_000_000) amount!: number;
}
export class DecisionDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
export class PaymentAccountDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) number!: string;
  @IsOptional() @IsString() @MaxLength(450000)
  @Matches(/^(?:|data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2})$/)
  imageUrl?: string;
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  instructions!: string;
}
export class MonthlyQueryDto {
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month?: string;
}
export class GenerateBillsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
}
