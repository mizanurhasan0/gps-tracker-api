import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { trim } from '../auth/auth.dto';

export class StudentScheduleDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40) shiftId?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({each:true}) @Min(0,{each:true}) @Max(6,{each:true}) operatingDays?: number[];
}
export class StudentProfileDto extends StudentScheduleDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) studentCode?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) className?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) roll?: string;
  @IsOptional() @IsString() @MaxLength(450000) @Matches(/^(?:|https:\/\/[^\s]+|data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2})$/) photoUrl?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) pickupAddress?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) dropAddress?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) @Matches(/^[+\d ()-]*$/) emergencyContact?: string;
}
export class StudentDetailsDto extends StudentProfileDto {
  @IsOptional() @IsUUID() dropoffStopId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100000000) monthlyAmount?: number;
  @IsOptional() @IsIn(['ACTIVE','STOPPED']) status?: 'ACTIVE' | 'STOPPED';
}
export class CreateStudentDto extends StudentDetailsDto {
  @IsOptional() @IsUUID() studentId?: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) studentName!: string;
  @Transform(trim) @IsString() @Matches(/^(?:\+?88)?01[3-9]\d{8}$/) guardianPhone!: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) guardianName?: string;
  @IsUUID() routeId!: string;
  @IsUUID() stopId!: string;
}
export class UpdateStudentDto extends StudentDetailsDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) studentName?: string;
  @IsOptional() @Transform(trim) @IsString() @Matches(/^(?:\+?88)?01[3-9]\d{8}$/) guardianPhone?: string;
  @IsOptional() @IsUUID() routeId?: string;
  @IsOptional() @IsUUID() stopId?: string;
}
export class DriverDetailsDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) nid?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) address?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) joiningDate?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) monthlySalary?: number;
  @IsOptional() @IsIn(['ACTIVE','LEAVE','INACTIVE']) status?: 'ACTIVE' | 'LEAVE' | 'INACTIVE';
  @IsOptional() @IsUUID() vehicleId?: string | null;
}
export class CreateDriverDto extends DriverDetailsDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @Transform(trim) @IsString() @Matches(/^(?:\+?88)?01[3-9]\d{8}$/) phone!: string;
}
export class UpdateDriverDto extends DriverDetailsDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @Transform(trim) @IsString() @Matches(/^(?:\+?88)?01[3-9]\d{8}$/) phone?: string;
}
export class AttendanceEntryDto {
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) date!: string;
  @IsIn(['PRESENT','ABSENT','LEAVE']) status!: 'PRESENT' | 'ABSENT' | 'LEAVE';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
export class AttendanceBatchDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(()=>AttendanceEntryDto) entries!: AttendanceEntryDto[];
}
export class CreateMaintenanceDto {
  @IsUUID() vehicleId!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) serviceDate!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) nextServiceDate?: string | null;
  @IsInt() @Min(0) @Max(100000000) amount!: number;
  @IsOptional() @IsIn(['PLANNED','IN_PROGRESS','COMPLETED']) status?: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED';
}
export class UpdateMaintenanceDto {
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) serviceDate?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) nextServiceDate?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) amount?: number;
  @IsOptional() @IsIn(['PLANNED','IN_PROGRESS','COMPLETED']) status?: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED';
}
export class CreateLedgerDto {
  @IsIn(['INCOME','EXPENSE','INVESTMENT']) type!: 'INCOME' | 'EXPENSE' | 'INVESTMENT';
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) category!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsInt() @Min(1) @Max(100000000) amount!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) date!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsUUID() driverId?: string;
}
export class CreateNoticeDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(2000) body!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) category!: string;
  @IsIn(['ALL','ROUTE','VEHICLE','STUDENT']) audience!: 'ALL' | 'ROUTE' | 'VEHICLE' | 'STUDENT';
  @IsOptional() @IsUUID() targetId?: string;
}
export class CreateManagementRequestDto {
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsIn(['ABSENCE','LEAVE','MAINTENANCE','OTHER']) category!: 'ABSENCE' | 'LEAVE' | 'MAINTENANCE' | 'OTHER';
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(2000) description!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) date?: string;
}
export class TransportShiftDto {
  @Transform(trim) @IsString() @Matches(/^[A-Za-z0-9_-]{1,40}$/) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) startTime!: string;
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) endTime!: string;
}
export class SettingsDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({each:true}) @Min(0,{each:true}) @Max(6,{each:true}) operatingDays?: number[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(()=>TransportShiftDto) transportShifts?: TransportShiftDto[];
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) businessName?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) @Matches(/^[+\d ()-]*$/) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) address?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) @Matches(/^[+\d ()-]*$/) emergencyPhone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) @Matches(/^[+\d ()-]*$/) whatsappNumber?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) paymentReminder?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) absenceMessage?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) delayMessage?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) holidayMessage?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) emergencyMessage?: string;
}
export class ScheduleEntryDto {
  @IsOptional() @IsUUID() stopId?: string | null;
  @IsOptional() @IsUUID() studentId?: string | null;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) label!: string;
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) time!: string;
  @IsIn(['MORNING','AFTERNOON']) period!: 'MORNING' | 'AFTERNOON';
  @IsInt() @Min(0) @Max(500) position!: number;
}
export class ScheduleDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(()=>ScheduleEntryDto) entries!: ScheduleEntryDto[];
}
