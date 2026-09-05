import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class LoginDto {
  @Transform(trim) @Matches(/^01[3-9]\d{8}$/) phone!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
}
export class RegisterDto extends LoginDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
}
