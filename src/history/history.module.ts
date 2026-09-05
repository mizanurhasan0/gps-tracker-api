import { Module } from '@nestjs/common';
import { HistoryController } from './history.controller';
import { HistoryIngestion } from './history.ingestion';
import { HistoryRepository } from './history.repository';
import { HistoryService } from './history.service';

@Module({
  controllers: [HistoryController],
  providers: [HistoryRepository, HistoryIngestion, HistoryService],
  exports: [HistoryIngestion],
})
export class HistoryModule {}
