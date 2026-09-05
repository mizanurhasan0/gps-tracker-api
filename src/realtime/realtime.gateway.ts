import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { appConfig } from '../config/app.config';
import type { DeviceLocation } from '../locations/location.types';

export const LOCATION_UPDATE_EVENT = 'location:update';

@WebSocketGateway(appConfig.socket.port, {
  cors: { origin: appConfig.cors.origin },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server?: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  publishLocation(location: DeviceLocation): void {
    this.server?.emit(LOCATION_UPDATE_EVENT, location);
  }
}
