import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { appConfig } from '../config/app.config';
import { JsonStore } from '../common/json-store';
import { isValidCoordinates, normalizeCoordinates } from './coordinates';
import type {
  DeviceLocation,
  DevicePosition,
  DeviceRecord,
  DeviceStatus,
} from './location.types';

export interface PositionReport {
  imei: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  gpsTime: string;
}

export interface StatusReport {
  gsmSignal?: number;
  voltageLevel?: number;
}

@Injectable()
export class LocationsService implements OnModuleInit {
  private readonly logger = new Logger(LocationsService.name);
  private readonly store = new JsonStore<DeviceRecord[]>(
    appConfig.storage.dataDir,
    'devices.json',
  );
  private readonly devices = new Map<string, DeviceRecord>();

  onModuleInit(): void {
    for (const record of this.store.read([])) {
      const migrated = migrateRecord(record);
      if (migrated) {
        this.devices.set(migrated.imei, migrated);
      }
    }

    this.logger.log(`Restored ${this.devices.size} device record(s)`);
  }

  /** Records any contact from the device, optionally with modem status */
  touch(imei: string, status: StatusReport = {}): DeviceRecord {
    const existing = this.devices.get(imei);
    const record: DeviceRecord = {
      ...existing,
      imei,
      lastSeen: new Date().toISOString(),
      gsmSignal: status.gsmSignal ?? existing?.gsmSignal,
      voltageLevel: status.voltageLevel ?? existing?.voltageLevel,
    };

    this.devices.set(imei, record);
    return record;
  }

  /**
   * Stores a GPS fix. Reports without a usable fix only refresh `lastSeen`, so
   * the previous position stays available as the last known location.
   */
  savePosition(report: PositionReport): DeviceLocation {
    if (!isValidCoordinates(report.latitude, report.longitude)) {
      return this.toLocation(this.touch(report.imei));
    }

    const { latitude, longitude } = normalizeCoordinates(
      report.latitude,
      report.longitude,
    );

    const position: DevicePosition = {
      latitude,
      longitude,
      speed: report.speed,
      course: report.course,
      gpsTime: report.gpsTime,
      receivedAt: new Date().toISOString(),
    };

    const record: DeviceRecord = { ...this.touch(report.imei), position };
    this.devices.set(record.imei, record);
    this.persist();

    return this.toLocation(record);
  }

  findAll(): DeviceLocation[] {
    return [...this.devices.values()].map(record => this.toLocation(record));
  }

  findByImei(imei: string): DeviceLocation | null {
    const record = this.devices.get(imei);
    return record ? this.toLocation(record) : null;
  }

  private toLocation(record: DeviceRecord): DeviceLocation {
    const { onlineThresholdMs } = appConfig.devices;
    const now = Date.now();

    const online = now - Date.parse(record.lastSeen) < onlineThresholdMs;
    const position = record.position;
    const fixIsRecent = position
      ? now - Date.parse(position.receivedAt) < onlineThresholdMs
      : false;

    const status: DeviceStatus = !online
      ? 'offline'
      : !position
        ? 'waiting'
        : fixIsRecent
          ? 'live'
          : 'lastKnown';

    return {
      imei: record.imei,
      status,
      online,
      lastSeen: record.lastSeen,
      gsmSignal: record.gsmSignal,
      voltageLevel: record.voltageLevel,
      hasFix: Boolean(position),
      latitude: position?.latitude,
      longitude: position?.longitude,
      speed: position?.speed,
      course: position?.course,
      gpsTime: position?.gpsTime,
      positionAt: position?.receivedAt,
    };
  }

  private persist(): void {
    this.store.write([...this.devices.values()]);
  }
}

/** Legacy record shape written before positions were nested */
interface LegacyDeviceRecord {
  imei?: string;
  latitude?: number;
  longitude?: number;
  speed?: number;
  course?: number;
  gpsTime?: string;
  timestamp?: string;
  lastSeen?: string;
  gsmSignal?: number;
  voltageLevel?: number;
  lastValidLatitude?: number;
  lastValidLongitude?: number;
  lastValidGpsTime?: string;
  lastValidTimestamp?: string;
}

function migrateRecord(record: DeviceRecord): DeviceRecord | null {
  if (!record?.imei) {
    return null;
  }

  if (record.position) {
    return record;
  }

  const legacy = record as DeviceRecord & LegacyDeviceRecord;
  const latitude = legacy.lastValidLatitude ?? legacy.latitude;
  const longitude = legacy.lastValidLongitude ?? legacy.longitude;
  const lastSeen = legacy.lastSeen ?? new Date().toISOString();

  const base: DeviceRecord = {
    imei: record.imei,
    lastSeen,
    gsmSignal: legacy.gsmSignal,
    voltageLevel: legacy.voltageLevel,
  };

  if (latitude == null || longitude == null) {
    return base;
  }
  if (!isValidCoordinates(latitude, longitude)) {
    return base;
  }

  const normalized = normalizeCoordinates(latitude, longitude);

  return {
    ...base,
    position: {
      ...normalized,
      speed: legacy.speed ?? 0,
      course: legacy.course ?? 0,
      gpsTime: legacy.lastValidGpsTime ?? legacy.gpsTime ?? '',
      receivedAt: legacy.lastValidTimestamp ?? legacy.timestamp ?? lastSeen,
    },
  };
}
