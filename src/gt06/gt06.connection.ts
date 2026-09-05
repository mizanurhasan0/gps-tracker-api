import { Logger } from '@nestjs/common';
import type { Socket } from 'net';
import { appConfig } from '../config/app.config';
import type { LocationsService } from '../locations/locations.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
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
  private imei: string | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly locations: LocationsService,
    private readonly realtime: RealtimeGateway,
  ) {
    this.peer = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  get deviceLabel(): string {
    return this.imei ?? this.peer;
  }

  handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      const { frame, remaining } = findFrame(this.buffer);
      const madeProgress = remaining.length !== this.buffer.length;

      this.buffer = remaining;

      if (!frame) {
        if (!madeProgress) {
          break;
        }
        continue;
      }

      this.handleFrame(frame);
    }
  }

  handleClose(): void {
    this.logger.log(`Device disconnected: ${this.deviceLabel}`);
  }

  handleError(error: Error): void {
    this.logger.warn(`Socket error for ${this.deviceLabel}: ${error.message}`);
  }

  private handleFrame(raw: Buffer): void {
    let frame;

    try {
      frame = parseFrame(raw);
    } catch (error) {
      this.logger.warn(
        `Malformed frame from ${this.deviceLabel}: ${toHex(raw)} (${(error as Error).message})`,
      );
      return;
    }

    switch (frame.protocol) {
      case Gt06Protocol.LOGIN:
        this.handleLogin(frame.body);
        break;
      case Gt06Protocol.HEARTBEAT:
        this.handleHeartbeat(frame.body);
        break;
      case Gt06Protocol.GPS:
      case Gt06Protocol.ALARM:
      case Gt06Protocol.LBS:
        this.handlePositionReport(frame.body, frame.protocol);
        break;
      default:
        this.logger.debug(
          `Unhandled protocol 0x${frame.protocol.toString(16)} from ${this.deviceLabel}`,
        );
        break;
    }

    this.sendAck(frame.protocol, frame.serial);
  }

  private handleLogin(body: Buffer): void {
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
    this.locations.touch(imei);
    this.logger.log(`Device logged in: ${imei}`);
  }

  private handleHeartbeat(body: Buffer): void {
    if (!this.requireLogin('heartbeat')) {
      return;
    }

    const status = parseStatus(body);
    this.locations.touch(this.imei as string, status);

    this.logger.debug(
      `Heartbeat ${this.imei} — GSM ${status.gsmSignal}, battery ${status.voltageLevel}`,
    );
  }

  private handlePositionReport(body: Buffer, protocol: number): void {
    if (!this.requireLogin(`protocol 0x${protocol.toString(16)}`)) {
      return;
    }

    const imei = this.imei as string;

    if (!hasPosition(body)) {
      this.locations.touch(imei);
      return;
    }

    const position = parsePosition(body);
    const location = this.locations.savePosition({ imei, ...position, protocol });

    if (location.hasFix) {
      this.logger.log(
        `Position ${imei} — ${location.latitude?.toFixed(6)}, ${location.longitude?.toFixed(6)} @ ${location.speed} km/h`,
      );
    }

    this.realtime.publishLocation(location);
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
