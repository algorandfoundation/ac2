import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { DIDDocument } from '@algorandfoundation/identities-store';

export interface BackupFile {
  uri: string;
  name: string;
  size: number;
  modificationTime: number;
}

export interface DIDBackupData {
  didDocument: DIDDocument;
  exportedAt: string;
  version: string;
}

export function generateBackupFilename(): string {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  return `did-backup-${timestamp}.json`;
}

export async function exportDidDocument(didDocument: DIDDocument): Promise<string> {
  const backupData: DIDBackupData = {
    didDocument,
    exportedAt: new Date().toISOString(),
    version: '1.0',
  };

  const jsonContent = JSON.stringify(backupData, null, 2);
  const filename = generateBackupFilename();
  const fileUri = `${FileSystem.documentDirectory}${filename}`;

  await FileSystem.writeAsStringAsync(fileUri, jsonContent);

  // Show share dialog
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/json',
    dialogTitle: 'Export DID Document Backup',
  });

  return fileUri;
}

export async function listBackupFiles(): Promise<BackupFile[]> {
  if (!FileSystem.documentDirectory) {
    return [];
  }

  const files = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
  const backupFiles: BackupFile[] = [];

  for (const filename of files) {
    if (filename.endsWith('.json') && filename.startsWith('did-backup-')) {
      const fileUri = `${FileSystem.documentDirectory}${filename}`;
      try {
        const fileInfo = await FileSystem.getInfoAsync(fileUri);

        if (fileInfo.exists && !fileInfo.isDirectory) {
          backupFiles.push({
            uri: fileUri,
            name: filename,
            size: fileInfo.size,
            modificationTime: fileInfo.modificationTime || Date.now(),
          });
        }
      } catch {
        console.warn(`Skipping unreadable backup file: ${filename}`);
      }
    }
  }

  return backupFiles.sort((a, b) => b.modificationTime - a.modificationTime);
}

export async function importDidDocument(
  fileUri: string,
  currentDid?: string,
): Promise<DIDDocument> {
  const jsonContent = await FileSystem.readAsStringAsync(fileUri);

  let backupData: DIDBackupData;
  try {
    backupData = JSON.parse(jsonContent);
  } catch {
    throw new Error('Invalid JSON format');
  }

  if (!backupData.didDocument || !backupData.didDocument.id) {
    throw new Error('Invalid backup format: missing DID Document');
  }

  if (currentDid && backupData.didDocument.id !== currentDid) {
    throw new Error(
      `DID mismatch: backup is for ${backupData.didDocument.id}, but current identity is ${currentDid}`,
    );
  }

  return backupData.didDocument;
}

export async function deleteBackupFile(fileUri: string): Promise<void> {
  await FileSystem.deleteAsync(fileUri);
}
