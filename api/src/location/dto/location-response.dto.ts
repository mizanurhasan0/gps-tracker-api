import { Expose } from 'class-transformer';

export class LocationResponseDto {
  @Expose()
  imei: string;

  @Expose()
  latitude: number;

  @Expose()
  longitude: number;

  @Expose()
  speed: number;

  @Expose()
  timestamp: string;
}
