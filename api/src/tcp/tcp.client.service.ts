import { Logger } from '@nestjs/common';
import { Socket } from 'net';
import { Gt06Parser } from './gt06.parser';
import { PacketHelper } from './packet.helper';
import { LocationService } from '../location/location.service';
import { GpsGateway } from '../gateway/gps.gateway';
import { Gt06Protocol } from '../types/gt06.enum';
import type { GpsData } from '../interfaces/gps-data.interface';

export class TcpClientService {
  private readonly logger = new Logger(TcpClientService.name);
  private buffer: Buffer = Buffer.alloc(0);
  private deviceImei: string | null = null;
  private deviceId: string;

  constructor(
    private readonly socket: Socket,
    private readonly parser: Gt06Parser,
    private readonly locationService: LocationService,
    private readonly gpsGateway: GpsGateway,
  ) {
    this.deviceId = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    this.logger.log(`Raw packet: ${PacketHelper.hexDump(data)}`);

    while (this.buffer.length > 0) {
      const { packet, remaining } = this.parser.findPacket(this.buffer);

      if (!packet) {
        break;
      }

      this.buffer = remaining;
      this.processPacket(packet);
    }
  }

  private processPacket(packet: Buffer): void {
    try {
      const parsed = this.parser.parsePacket(packet);

      this.logger.log(`Parsed packet - Protocol: 0x${parsed.protocolNumber.toString(16)}, Serial: ${parsed.serialNumber}`);

      switch (parsed.protocolNumber) {
        case Gt06Protocol.LOGIN:
          this.handleLogin(parsed);
          break;
        case Gt06Protocol.GPS_DATA:
          this.handleGpsData(parsed);
          break;
        case Gt06Protocol.ALARM:
          this.logger.warn(`Alarm received from device ${this.deviceImei || this.deviceId}`);
          this.handleGpsData(parsed);
          break;
        default:
          this.logger.warn(`Unknown protocol: 0x${parsed.protocolNumber.toString(16)}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Failed to process packet: ${(error as Error).message}`);
    }
  }

  private handleLogin(parsed: { body: Buffer; serialNumber: number }): void {
    const login = this.parser.parseLogin(parsed.body, parsed.serialNumber);

    this.deviceImei = login.imei;
    this.parser.setImei(this.deviceId, login.imei);

    this.logger.log(`Device logged in - IMEI: ${login.imei}`);

    const response = PacketHelper.buildResponse(Gt06Protocol.LOGIN, login.serialNumber);
    this.socket.write(response);
  }

  private handleGpsData(parsed: { body: Buffer; serialNumber: number }): void {
    const imei = this.deviceImei;
    if (!imei) {
      this.logger.warn('GPS data received before login');
      this.parser.setImei(this.deviceId, 'unknown');
      return;
    }

    const gps = this.parser.parseGpsData(parsed.body, imei, parsed.serialNumber);

    this.logger.log(`GPS Data - IMEI: ${gps.imei}, Lat: ${gps.latitude.toFixed(6)}, Lng: ${gps.longitude.toFixed(6)}, Speed: ${gps.speed} km/h, Time: ${gps.gpsTime}`);

    const gpsData: GpsData = {
      imei: gps.imei,
      latitude: gps.latitude,
      longitude: gps.longitude,
      speed: gps.speed,
      course: gps.course,
      timestamp: new Date().toISOString(),
      gpsTime: gps.gpsTime,
      status: gps.status,
    };

    this.locationService.setLatestLocation(gpsData);

    this.gpsGateway.broadcastLocationUpdate(gpsData);

    const response = PacketHelper.buildResponse(Gt06Protocol.GPS_DATA, gps.serialNumber);
    this.socket.write(response);
  }

  handleDisconnect(): void {
    this.logger.log(`Device disconnected - ${this.deviceImei || this.deviceId}`);
  }

  handleError(error: Error): void {
    this.logger.error(`Socket error for device ${this.deviceImei || this.deviceId}: ${error.message}`);
  }
}
