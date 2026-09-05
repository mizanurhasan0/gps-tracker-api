import { Logger } from '@nestjs/common';
import type { Socket } from 'net';
import { appConfig } from '../config/app.config';
import type { LocationsService } from '../locations/locations.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { DeviceLocation } from '../locations/location.types';
import {
  buildAck,
  findFrame,
  hasLogin,
  hasPosition,
  parseFrame,
  parseLogin,
  parsePosition,
  parseStatus,
  toHex,
} from './gt06.codec';
import { Gt06Protocol } from './gt06.types';

/** Handles the GT06 conversation for a single device socket */
export class Gt06Connection {
  private readonly logger = new Logger(Gt06Connection.name);
  private readonly peer: string;
  private buffer: Buffer = Buffer.alloc(0);
  private processing = false;
  private closed = false;
  private publishing = false;
  private pendingLocation?: DeviceLocation;
  private static readonly MAX_BUFFER_BYTES = 128 * 1024;
  private imei: string | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly locations: LocationsService,
    private readonly realtime: RealtimeGateway
  ) {
    this.peer = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  get deviceLabel(): string {
    return this.imei ?? this.peer;
  }

  handleData(chunk: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    if (this.buffer.length + chunk.length > Gt06Connection.MAX_BUFFER_BYTES) {
      this.logger.warn(`Input buffer limit exceeded for ${this.deviceLabel}`);
      this.close();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.processing) void this.drain();
  }

  private async drain(): Promise<void> {
    this.processing = true;
    this.socket.pause();
    try {
      while (this.buffer.length > 0 && !this.closed && !this.socket.destroyed) {
        const { frame, remaining } = findFrame(this.buffer);
        const madeProgress = remaining.length !== this.buffer.length;
        this.buffer = remaining;
        if (!frame) {
          if (!madeProgress) break;
          continue;
        }
        await this.handleFrame(frame);
      }
    } catch {
      // No ACK for the failed commit. Firmware may reconnect and retransmit;
      // delivery during outages still depends on the device's own retry/storage.
      this.logger.error(
        `Device persistence failed for ${this.deviceLabel}; closing without ACK`
      );
      this.close();
    } finally {
      this.processing = false;
      if (!this.closed && !this.socket.destroyed) this.socket.resume();
    }
  }

  private close(): void {
    this.closed = true;
    this.pendingLocation = undefined;
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
  }

  handleClose(): void {
    this.closed = true;
    this.pendingLocation = undefined;
    this.buffer = Buffer.alloc(0);
    this.logger.log(`Device disconnected: ${this.deviceLabel}`);
  }

  handleError(error: Error): void {
    this.logger.warn(`Socket error for ${this.deviceLabel}: ${error.message}`);
  }

  private async handleFrame(raw: Buffer): Promise<void> {
    let frame;

    try {
      frame = parseFrame(raw);
    } catch (error) {
      this.logger.warn(
        `Malformed frame from ${this.deviceLabel}: ${toHex(raw)} (${
          (error as Error).message
        })`
      );
      return;
    }

    switch (frame.protocol) {
      case Gt06Protocol.LOGIN:
        await this.handleLogin(frame.body);
        break;
      case Gt06Protocol.HEARTBEAT:
        await this.handleHeartbeat(frame.body);
        break;
      case Gt06Protocol.GPS:
      case Gt06Protocol.ALARM:
      case Gt06Protocol.LBS:
        await this.handlePositionReport(frame.body, frame.protocol);
        break;
      default:
        this.logger.debug(
          `Unhandled protocol 0x${frame.protocol.toString(16)} from ${
            this.deviceLabel
          }`
        );
        break;
    }

    this.sendAck(frame.protocol, frame.serial);
  }

  private async handleLogin(body: Buffer): Promise<void> {
    if (!hasLogin(body)) {
      this.logger.warn(`Truncated login packet from ${this.peer}`);
      return;
    }

    const { imei } = parseLogin(body);
    const { allowedImeis } = appConfig.devices;

    if (allowedImeis.length > 0 && !allowedImeis.includes(imei)) {
      this.logger.warn(`Rejected device with IMEI ${imei} (not allowlisted)`);
      this.socket.destroy();
      return;
    }

    this.imei = imei;
    await this.locations.touch(imei);
    this.logger.log(`Device logged in: ${imei}`);
  }

  private async handleHeartbeat(body: Buffer): Promise<void> {
    if (!this.requireLogin('heartbeat')) {
      return;
    }

    const status = parseStatus(body);
    await this.locations.touch(this.imei as string, status);

    this.logger.debug(
      `Heartbeat ${this.imei} — GSM ${status.gsmSignal}, battery ${status.voltageLevel}`
    );
  }

  private async handlePositionReport(
    body: Buffer,
    protocol: number
  ): Promise<void> {
    if (!this.requireLogin(`protocol 0x${protocol.toString(16)}`)) {
      return;
    }

    const imei = this.imei as string;

    if (!hasPosition(body)) {
      await this.locations.touch(imei);
      return;
    }

    const position = parsePosition(body);
    const location = await this.locations.savePosition({
      imei,
      ...position,
      protocol,
    });

    if (location.hasFix) {
      this.logger.log(
        `Position ${imei} — ${location.latitude?.toFixed(
          6
        )}, ${location.longitude?.toFixed(6)} @ ${location.speed} km/h`
      );
    }

    // Coalesce live display updates separately: each connection holds at most
    // one publishing operation and one pending position. Slow viewers must not
    // delay ACKs for committed GPS records or grow an unbounded promise queue.
    this.pendingLocation = location;
    if (!this.publishing) void this.publishPending();
  }

  private async publishPending(): Promise<void> {
    this.publishing = true;
    try {
      while (this.pendingLocation && !this.closed && !this.socket.destroyed) {
        const location = this.pendingLocation;
        this.pendingLocation = undefined;
        try {
          await this.realtime.publishLocation(location);
        } catch {
          this.logger.warn(`Realtime delivery failed for ${this.deviceLabel}`);
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  private requireLogin(context: string): boolean {
    if (this.imei) {
      return true;
    }

    this.logger.warn(`Ignoring ${context} from ${this.peer} before login`);
    return false;
  }

  private sendAck(protocol: number, serial: number): void {
    if (this.socket.destroyed) {
      return;
    }
    this.socket.write(buildAck(protocol, serial));
  }
}
