import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createServer, Server, Socket } from 'net';
import { appConfig } from '../config/app.config';
import { LocationsService } from '../locations/locations.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Gt06Connection } from './gt06.connection';

@Injectable()
export class Gt06Server implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Gt06Server.name);
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly locations: LocationsService,
    private readonly realtime: RealtimeGateway
  ) {}

  onModuleInit(): void {
    const { host, port, publicHost } = appConfig.tcp;

    this.server = createServer((socket) => this.handleSocket(socket));

    this.server.on('error', (error) => {
      this.logger.error(`TCP server error: ${error.message}`);
    });

    this.server.listen(port, host, () => {
      this.logger.log(`GT06 listener ready on ${host}:${port}`);
      this.logger.log(`Device SMS setup: SERVER,0,${publicHost},${port},0#`);
    });
  }

  onModuleDestroy(): void {
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);

    const connection = new Gt06Connection(
      socket,
      this.locations,
      this.realtime
    );

    this.logger.log(`Device connected: ${connection.deviceLabel}`);

    socket.on('data', (chunk) => {
      try {
        connection.handleData(chunk);
      } catch (error) {
        this.logger.error(
          `Failed handling data from ${connection.deviceLabel}: ${
            (error as Error).message
          }`
        );
        // No ACK was sent for the failed frame. Reconnect permits device retry;
        // never keep consuming a stream after the database commit failed.
        socket.destroy();
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      connection.handleClose();
    });
    socket.on('error', (error) => connection.handleError(error));
  }
}
