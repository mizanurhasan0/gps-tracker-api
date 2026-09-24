import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class RecoveryRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class RecoveryConfirmDto extends RecoveryRequestDto {
  @IsUUID('4') requestId!: string;
  @IsString() @Matches(/^\d{8}$/) otp!: string;
  @IsString() @MinLength(12) @MaxLength(128) newPassword!: string;
  @IsString() @MinLength(12) @MaxLength(128) confirmPassword!: string;
}
