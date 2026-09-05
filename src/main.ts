import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();
  app.enableCors({ origin: appConfig.cors.origin });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(appConfig.rest.port);

  const { publicHost, port: tcpPort } = appConfig.tcp;
  logger.log(`REST API      http://${publicHost}:${appConfig.rest.port}`);
  logger.log(`Socket.IO     http://${publicHost}:${appConfig.socket.port}`);
  logger.log(`GT06 devices  ${publicHost}:${tcpPort}`);
}

void bootstrap();
