import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  await app.listen(appConfig.rest.port);

  console.log(`REST API running on http://localhost:${appConfig.rest.port}`);
  console.log(`Socket.IO ready on port ${appConfig.socket.port}`);
}

bootstrap();
