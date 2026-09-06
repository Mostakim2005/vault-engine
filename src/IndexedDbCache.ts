import type { IndexedFile } from './VaultIndex';

const DATABASE_PREFIX = 'navigation-suite-vault-engine';
const STORE_NAME = 'state';
const DATABASE_VERSION = 1;

export interface CachePayload {
	schemaVersion: number;
	files: IndexedFile[];
	vaultFingerprint: string;
}

function fingerprintVault(files: readonly { path: string; stat: { mtime: number; size: number } }[]): string {
	let hash = 2166136261;
	const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
	for (const file of sorted) {
		const value = `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}\u0000`;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createVaultFingerprint(files: readonly { path: string; stat: { mtime: number; size: number } }[]): string {
	return fingerprintVault(files);
}

export class IndexedDbCache {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private readonly databaseName: string;
	private readonly stateKey: string;

	constructor(vaultName: string) {
		const safeName = vaultName.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'vault';
		this.databaseName = `${DATABASE_PREFIX}:${safeName}`;
		this.stateKey = 'index';
	}

	async open(): Promise<void> {
		if (this.database) return;
		if (this.opening) {
			await this.opening;
			return;
		}

		this.opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					if (this.database === database) this.database = null;
				};
				resolve(database);
			};
			request.onerror = () => reject(request.error ?? new Error('Failed to open cache database.'));
		});

		try {
			this.database = await this.opening;
		} finally {
			this.opening = null;
		}
	}

	async load(): Promise<CachePayload | null> {
		await this.open();
		const database = this.database;
		if (!database) return null;
		return new Promise<CachePayload | null>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readonly');
			const request = transaction.objectStore(STORE_NAME).get(this.stateKey);
			request.onsuccess = () => {
				const value = request.result as unknown;
				resolve(this.isCachePayload(value) ? value : null);
			};
			request.onerror = () => reject(request.error ?? new Error('Failed to read cache.'));
		});
	}

	async save(payload: CachePayload): Promise<void> {
		await this.open();
		const database = this.database;
		if (!database) return;
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			transaction.objectStore(STORE_NAME).put(payload, this.stateKey);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Failed to write cache.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Cache write was aborted.'));
		});
	}

	close(): void {
		this.database?.close();
		this.database = null;
		this.opening = null;
	}

	private isCachePayload(value: unknown): value is CachePayload {
		if (!value || typeof value !== 'object') return false;
		const candidate = value as Partial<CachePayload>;
		return typeof candidate.schemaVersion === 'number'
			&& typeof candidate.vaultFingerprint === 'string'
			&& Array.isArray(candidate.files);
	}
}
