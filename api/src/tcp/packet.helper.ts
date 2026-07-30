export class PacketHelper {
  static bcdToNumber(value: number): number {
    return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
  }

  static bcdBytesToNumber(bytes: Buffer, offset: number, length: number): number {
    let result = 0;
    for (let i = 0; i < length; i++) {
      const byte = bytes[offset + i];
      result = result * 100 + this.bcdToNumber(byte);
    }
    return result;
  }

  static hexDump(buffer: Buffer): string {
    return buffer.toString('hex').toUpperCase();
  }

  static calculateChecksum(data: Buffer): number {
    let checksum = 0;
    for (let i = 0; i < data.length; i++) {
      checksum ^= data[i];
    }
    return checksum;
  }

  static verifyChecksum(packet: Buffer, length: number): boolean {
    const dataLength = packet[2];
    const protocolIndex = 3;
    const crcStart = protocolIndex + length;
    const receivedCrc = (packet[crcStart] << 8) | packet[crcStart + 1];
    const dataForCrc = packet.subarray(protocolIndex, protocolIndex + length);
    const calculatedCrc = this.calculateChecksum(dataForCrc);
    return receivedCrc === calculatedCrc;
  }

  static extractImei(imeiBytes: Buffer): string {
    let imei = '';
    for (let i = 0; i < imeiBytes.length; i++) {
      const high = (imeiBytes[i] >> 4) & 0x0f;
      const low = imeiBytes[i] & 0x0f;
      if (i === imeiBytes.length - 1 && low === 0x0f) {
        imei += high.toString();
      } else {
        imei += high.toString() + low.toString();
      }
    }
    return imei;
  }

  static buildResponse(protocolNumber: number, serialNumber: number): Buffer {
    const body = Buffer.from([protocolNumber, 0x01]);
    const serialBuf = Buffer.alloc(2);
    serialBuf.writeUInt16BE(serialNumber, 0);

    const content = Buffer.concat([body, serialBuf]);
    const checksum = this.calculateChecksum(content);
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16BE(checksum, 0);

    const start = Buffer.from([0x78, 0x78]);
    const length = Buffer.from([content.length + 2]);
    const stop = Buffer.from([0x0D, 0x0A]);

    return Buffer.concat([start, length, content, crcBuf, stop]);
  }
}
