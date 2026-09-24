import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request } from 'node:https';
import { BackupConfig } from './backup.config';

export interface DriveBackupFile {
  id: string;
  name: string;
  webViewLink?: string;
  createdTime?: string;
  size?: string;
}

export class GoogleDriveBackupClient {
  constructor(private readonly config: BackupConfig['google']) {}

  private async accessToken(): Promise<string> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as { access_token?: string; error?: string };
    if (!response.ok || !payload.access_token)
      throw new Error(`Google OAuth failed (${response.status}): ${payload.error || 'no token'}`);
    return payload.access_token;
  }

  async upload(path: string, name: string, timeoutMs: number): Promise<DriveBackupFile> {
    const token = await this.accessToken();
    const initiate = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,createdTime,size',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
        },
        body: JSON.stringify({
          name,
          parents: [this.config.folderId],
          appProperties: {
            source: 'gps-tracker-api',
            kind: 'encrypted-postgres-backup',
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const uploadUrl = initiate.headers.get('location');
    if (!initiate.ok || !uploadUrl)
      throw new Error(`Google Drive upload initialization failed (${initiate.status})`);
    const size = (await stat(path)).size;
    return this.putFile(uploadUrl, path, size, token, timeoutMs);
  }

  private putFile(
    uploadUrl: string,
    path: string,
    size: number,
    token: string,
    timeoutMs: number,
  ): Promise<DriveBackupFile> {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const req = request(
        url,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/octet-stream',
            'content-length': size,
          },
          timeout: timeoutMs,
        },
        response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => {
            if (body.length < 64 * 1024) body += String(chunk);
          });
          response.on('end', () => {
            if ((response.statusCode || 500) >= 300)
              return reject(new Error(`Google Drive upload failed (${response.statusCode})`));
            try {
              resolve(JSON.parse(body) as DriveBackupFile);
            } catch {
              reject(new Error('Google Drive returned an invalid upload response'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Google Drive upload timed out')));
      req.on('error', reject);
      const source = createReadStream(path);
      source.on('error', error => req.destroy(error));
      source.pipe(req);
    });
  }

  async enforceRetention(keep: number): Promise<number> {
    const token = await this.accessToken();
    const query =
      `'${this.config.folderId}' in parents and trashed = false ` +
      "and appProperties has { key='source' and value='gps-tracker-api' } " +
      "and appProperties has { key='kind' and value='encrypted-postgres-backup' }";
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('orderBy', 'createdTime desc');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('fields', 'files(id,name,createdTime)');
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as { files?: DriveBackupFile[] };
    if (!response.ok) throw new Error(`Google Drive retention listing failed (${response.status})`);
    const expired = (payload.files || []).slice(keep);
    for (const file of expired) {
      const deleted = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!deleted.ok && deleted.status !== 404)
        throw new Error(`Google Drive retention delete failed (${deleted.status})`);
    }
    return expired.length;
  }
}
