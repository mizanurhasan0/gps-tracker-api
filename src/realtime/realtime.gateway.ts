import { WebSocketGateway, WebSocketServer, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import { appConfig } from '../config/app.config';
import type { DeviceLocation } from '../locations/location.types';
export const LOCATION_UPDATE_EVENT = 'location:update';
const AUTHORIZATION_BATCH_SIZE = 250;
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
    server.use(async (client, next) => {
      try {
        await this.auth.authenticate(client.handshake.auth.token);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
  }
  async publishLocation(location: DeviceLocation): Promise<void> {
    const clients = [...(this.server?.sockets.sockets.values() ?? [])];
    // Two fresh queries per batch instead of two per viewer. There is no access
    // cache: logout, expiry and stopped assignments apply on the next broadcast.
    for (let offset = 0; offset < clients.length; offset += AUTHORIZATION_BATCH_SIZE) {
      const batch = clients.slice(offset, offset + AUTHORIZATION_BATCH_SIZE);
      const users = await this.auth.authenticateMany(
        batch.map((client) => client.handshake.auth.token),
      );
      const allowed = await this.access.trackingUserIds(users.values(), location.imei);
      for (const client of batch) {
        if (client.connected === false) continue;
        const user = users.get(client.handshake.auth.token);
        if (!user) client.disconnect(true);
        else if (allowed.has(user.id)) client.emit(LOCATION_UPDATE_EVENT, location);
      }
    }
  }
}
