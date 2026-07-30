import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { GpsData } from '../interfaces/gps-data.interface';
import { appConfig } from '../config/app.config';

@WebSocketGateway(appConfig.socket.port, {
  cors: {
    origin: '*',
  },
  namespace: '/',
})
export class GpsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(GpsGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Frontend connected: ${client.id}`);
  }

  broadcastLocationUpdate(data: GpsData): void {
    const payload = {
      imei: data.imei,
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed,
      timestamp: data.timestamp,
    };

    this.server.emit('location:update', payload);

    this.logger.log(`Socket emitted location:update - IMEI: ${data.imei}`);
  }
}
