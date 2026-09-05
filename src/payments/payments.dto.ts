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
export class PaymentSubmissionDto {
  @IsUUID() billId!: string;
  @IsIn(['BKASH', 'ROCKET']) method!: 'BKASH' | 'ROCKET';
  @Transform(trim) @Matches(/^01[3-9]\d{8,9}$/) senderNumber!: string;
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9]{6,40}$/)
  transactionId!: string;
  @Transform(trim) @Matches(/^01[3-9]\d{8,9}$/) recipientNumber!: string;
  // All monetary amounts are integer poisha, never binary floating-point taka.
  @IsInt() @Min(1) @Max(100_000_000) amount!: number;
}
export class DecisionDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
export class PaymentAccountDto {
  @Transform(trim) @Matches(/^01[3-9]\d{8,9}$/) number!: string;
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  instructions!: string;
}
export class MonthlyQueryDto {
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month?: string;
}
export class GenerateBillsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
}
