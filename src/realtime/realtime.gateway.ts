import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import { appConfig } from '../config/app.config';
import type { DeviceLocation } from '../locations/location.types';
export const LOCATION_UPDATE_EVENT = 'location:update';
@WebSocketGateway(appConfig.socket.port, {
  cors: { origin: appConfig.cors.origin },
})
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() private server?: Server;
  constructor(
    private readonly auth: AuthService,
    private readonly access: AccessService,
  ) {}
  afterInit(server: Server): void {
    server.use((client, next) => {
      try {
        this.auth.authenticate(client.handshake.auth.token);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
  }
  publishLocation(location: DeviceLocation): void {
    // Recheck each delivery: stopped subscriptions, logout and expired sessions
    // lose access immediately, including on already-connected sockets.
    for (const client of this.server?.sockets.sockets.values() ?? []) {
      try {
        const user = this.auth.authenticate(client.handshake.auth.token);
        if (this.access.canTrack(user, location.imei))
          client.emit(LOCATION_UPDATE_EVENT, location);
      } catch {
        client.disconnect(true);
      }
    }
  }
}
