import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { appConfig } from '../../config/app.config';

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
  @IsString()
  @MinLength(appConfig.auth.allowShortPasswords ? 1 : 12)
  @MaxLength(128)
  newPassword!: string;
  @IsString()
  @MinLength(appConfig.auth.allowShortPasswords ? 1 : 12)
  @MaxLength(128)
  confirmPassword!: string;
}
