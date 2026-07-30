import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as net from 'net';
import { Gt06Parser } from './gt06.parser';
import { TcpClientService } from './tcp.client.service';
import { LocationService } from '../location/location.service';
import { GpsGateway } from '../gateway/gps.gateway';
import { appConfig } from '../config/app.config';

@Injectable()
export class TcpServer implements OnModuleInit {
  private readonly logger = new Logger(TcpServer.name);
  private server: net.Server;

  constructor(
    private readonly parser: Gt06Parser,
    private readonly locationService: LocationService,
    private readonly gpsGateway: GpsGateway,
  ) {}

  onModuleInit(): void {
    this.startServer();
  }

  private startServer(): void {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (error) => {
      this.logger.error(`TCP Server error: ${error.message}`);
    });

    this.server.listen(appConfig.tcp.port, () => {
      this.logger.log(`TCP Server started on port ${appConfig.tcp.port}`);
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.logger.log(`Device connected from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.setKeepAlive(true);
    socket.setNoDelay(true);

    const clientService = new TcpClientService(
      socket,
      this.parser,
      this.locationService,
      this.gpsGateway,
    );

    socket.on('data', (data: Buffer) => {
      clientService.handleData(data);
    });

    socket.on('close', () => {
      clientService.handleDisconnect();
    });

    socket.on('error', (error: Error) => {
      clientService.handleError(error);
    });
  }
}
