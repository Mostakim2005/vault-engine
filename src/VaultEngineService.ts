import type { SearchRequest, SearchResult, VaultEngineApi, VaultEngineCapabilities, VaultEngineEvent, FileRecord, FolderChildren } from '@navigation-suite/contracts';
import { VAULT_ENGINE_API_VERSION } from '@navigation-suite/contracts';
import type { SearchEngine } from './SearchEngine';
import type { VaultIndex } from './VaultIndex';

export class VaultEngineService implements VaultEngineApi {
	readonly capabilities: VaultEngineCapabilities = {
		apiVersion: VAULT_ENGINE_API_VERSION,
		fileIndex: true,
		tagIndex: true,
		propertyIndex: true,
		search: true,
		previews: false,
	};

	private readonly listeners = new Map<VaultEngineEvent, Set<() => void>>();

	constructor(private readonly index: VaultIndex, private readonly searchEngine: SearchEngine) {}

	getFile(path: string): FileRecord | null { return this.index.getFile(path); }

	getFolderChildren(path: string): FolderChildren { return this.index.getFolderChildren(path); }

	getFilesForTag(tag: string): readonly string[] { return this.index.getFilesForTag(tag); }

	getAllTags(): readonly string[] { return this.index.getAllTags(); }

	getFilesForProperty(key: string, value: string): readonly string[] { return this.index.getFilesForProperty(key, value); }

	search(request: SearchRequest): readonly SearchResult[] { return this.searchEngine.search(request); }

	subscribe(event: VaultEngineEvent, listener: () => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}

	emit(event: VaultEngineEvent): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			try {
				listener();
			} catch (error) {
				console.warn(`Vault Engine listener failed for ${event}.`, error);
			}
		}
	}
}
