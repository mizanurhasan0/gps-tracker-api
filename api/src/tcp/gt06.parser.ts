import { Injectable } from '@nestjs/common';
import { PacketHelper } from './packet.helper';
import {
  Gt06Protocol,
} from '../types/gt06.enum';
import type {
  LoginPacket,
  GpsPacket,
  ParsedPacket,
} from '../interfaces/gt06-packet.interface';
import { GT06_START_BYTE_1, GT06_START_BYTE_2 } from '../common/constants';

@Injectable()
export class Gt06Parser {
  private imeiByDevice: Map<string, string> = new Map();

  setImei(deviceId: string, imei: string): void {
    this.imeiByDevice.set(deviceId, imei);
  }

  getImei(deviceId: string): string | undefined {
    return this.imeiByDevice.get(deviceId);
  }

  findPacket(buffer: Buffer): { packet: Buffer | null; remaining: Buffer } {
    const startIndex = buffer.indexOf(Buffer.from([GT06_START_BYTE_1, GT06_START_BYTE_2]));

    if (startIndex === -1) {
      return { packet: null, remaining: Buffer.alloc(0) };
    }

    if (startIndex > 0) {
      buffer = buffer.subarray(startIndex);
    }

    if (buffer.length < 5) {
      return { packet: null, remaining: buffer };
    }

    const length = buffer[2];
    const totalPacketLength = 2 + 1 + length + 2 + 2;

    if (buffer.length < totalPacketLength) {
      return { packet: null, remaining: buffer };
    }

    const packet = buffer.subarray(0, totalPacketLength);
    const remaining = buffer.subarray(totalPacketLength);

    return { packet, remaining };
  }

  parsePacket(raw: Buffer): ParsedPacket {
    const protocolNumber = raw[3];
    const dataLength = raw[2];
    const body = raw.subarray(3, 3 + dataLength - 2);
    const serialNumber = raw.readUInt16BE(3 + dataLength - 2);

    return {
      protocolNumber,
      serialNumber,
      body,
      raw,
    };
  }

  parseLogin(body: Buffer, serialNumber: number): LoginPacket {
    const imeiBytes = body.subarray(1, 9);
    const imei = PacketHelper.extractImei(imeiBytes);

    return {
      imei,
      serialNumber,
    };
  }

  parseGpsData(body: Buffer, imei: string, serialNumber: number): GpsPacket {
    const timeBytes = body.subarray(1, 7);

    const year = PacketHelper.bcdToNumber(timeBytes[0]) + 2000;
    const month = PacketHelper.bcdToNumber(timeBytes[1]);
    const day = PacketHelper.bcdToNumber(timeBytes[2]);
    const hour = PacketHelper.bcdToNumber(timeBytes[3]);
    const minute = PacketHelper.bcdToNumber(timeBytes[4]);
    const second = PacketHelper.bcdToNumber(timeBytes[5]);

    const gpsInfo = body[7];

    const latRaw = PacketHelper.bcdBytesToNumber(body, 8, 4);
    const latitude = this.parseLatitude(latRaw);

    const lonRaw = PacketHelper.bcdBytesToNumber(body, 12, 4);
    const longitude = this.parseLongitude(lonRaw);

    const speed = body[16];

    const course = body.readUInt16BE(17);

    const status = body.readUInt16BE(19);

    const latDirection = (status >> 4) & 1 ? -1 : 1;
    const lonDirection = (status >> 5) & 1 ? -1 : 1;

    const gpsTime = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

    return {
      imei,
      latitude: latitude * latDirection,
      longitude: longitude * lonDirection,
      speed,
      course,
      year,
      month,
      day,
      hour,
      minute,
      second,
      gpsTime,
      status,
      serialNumber,
    };
  }

  private parseLatitude(raw: number): number {
    const degrees = Math.floor(raw / 1000000);
    const minutes = (raw % 1000000) / 10000;
    return degrees + minutes / 60;
  }

  private parseLongitude(raw: number): number {
    const degrees = Math.floor(raw / 100000);
    const minutes = (raw % 100000) / 1000;
    return degrees + minutes / 60;
  }
}
