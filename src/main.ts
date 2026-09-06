import { Plugin, TFile, TFolder } from 'obsidian';
import type { VaultEngineApi } from '@navigation-suite/contracts';
import { VaultIndex } from './VaultIndex';
import { ChangeBatcher, type FileChange } from './ChangeBatcher';
import { createVaultFingerprint, IndexedDbCache } from './IndexedDbCache';
import { SearchEngine } from './SearchEngine';
import { VaultEngineService } from './VaultEngineService';
import { PerformanceMetrics } from './PerformanceMetrics';
import { TaskScheduler } from './TaskScheduler';

const CACHE_SCHEMA_VERSION = 2;

export default class VaultEnginePlugin extends Plugin {
	private readonly index = new VaultIndex(this.app);
	private cache: IndexedDbCache | null = null;
	private readonly metrics = new PerformanceMetrics();
	private readonly searchEngine = new SearchEngine(this.index);
	private readonly service = new VaultEngineService(this.index, this.searchEngine);
	private readonly batcher = new ChangeBatcher((changes) => this.applyChanges(changes));
	private readonly scheduler = new TaskScheduler();
	private persistQueued = false;
	readonly api: VaultEngineApi = this.service;
	private initialized = false;


	async onload(): Promise<void> {
		this.cache = new IndexedDbCache(this.app.vault.getName());
		this.registerVaultEvents();
		await this.initialize();
	}

	onunload(): void {
		this.batcher.cancel();
		this.scheduler.dispose();
		this.cache?.close();
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile) this.batcher.push({ type: 'create', file });
			else if (file instanceof TFolder) {
				this.index.upsertFolder(file);
				this.schedulePersist('low');
				this.service.emit('folder-changed');
			}
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile) this.batcher.push({ type: 'modify', file });
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) this.batcher.push({ type: 'rename', file, oldPath });
			else if (file instanceof TFolder) {
				this.rebuildAfterFolderRename(file, oldPath);
			}
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile) this.batcher.push({ type: 'delete', path: file.path });
			else if (file instanceof TFolder) {
				this.index.removeFolder(file.path);
				this.schedulePersist('low');
				this.service.emit('folder-changed');
			}
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			this.batcher.push({ type: 'modify', file });
		}));
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		const loaded = await this.tryRestoreCache();
		if (!loaded) this.rebuildIndex();
		this.service.emit('index-ready');
	}

	private async tryRestoreCache(): Promise<boolean> {
		try {
			const cache = this.cache;
			if (!cache) return false;
			const payload = await cache.load();
			if (!payload || payload.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
			const currentFiles = this.app.vault.getAllLoadedFiles()
				.filter((file): file is TFile => file instanceof TFile)
				.map((file) => ({ path: file.path, stat: file.stat }));
			if (currentFiles.length !== payload.files.length) return false;
			if (createVaultFingerprint(currentFiles) !== payload.vaultFingerprint) return false;
			this.index.restore(payload.files);
			return true;
		} catch (error) {
			console.warn('Vault Engine: cache restore failed; rebuilding index.', error);
			return false;
		}
	}

	private rebuildIndex(): void {
		this.metrics.measure('index.rebuild', () => this.index.rebuild());
		this.schedulePersist('low');
	}

	private applyChanges(changes: readonly FileChange[]): void {
		let changed = false;
		for (const change of changes) {
			switch (change.type) {
				case 'create': {
					this.index.upsert(change.file);
					changed = true;
					this.service.emit('file-updated');
					break;
				}
				case 'modify': {
					const previous = this.index.getIndexedFile(change.file.path);
					this.index.upsert(change.file);
					changed = true;
					this.service.emit('file-updated');
					if (previous && !this.sameValues(previous.tags, this.index.getIndexedFile(change.file.path)?.tags ?? [])) this.service.emit('tag-changed');
					if (previous && !this.sameProperties(previous.properties, this.index.getIndexedFile(change.file.path)?.properties ?? [])) this.service.emit('property-changed');
					break;
				}
				case 'rename':
					this.index.move(change.oldPath, change.file);
					changed = true;
					this.service.emit('file-updated');
					this.service.emit('folder-changed');
					break;
				case 'delete':
					this.index.remove(change.path);
					changed = true;
					this.service.emit('file-removed');
					break;
			}
		}
		if (changed) this.schedulePersist(changes.length > 10 ? 'low' : 'normal');
	}

	private rebuildAfterFolderRename(folder: TFolder, oldPath: string): void {
		const renamed = this.index.renameFolder(oldPath, folder.path);
		if (!renamed) {
			this.index.upsertFolder(folder);
		}
		this.schedulePersist('low');
		this.service.emit('folder-changed');
		this.service.emit('file-updated');
	}

	private sameValues(left: readonly string[], right: readonly string[]): boolean {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	private sameProperties(left: readonly { key: string; value: string }[], right: readonly { key: string; value: string }[]): boolean {
		return left.length === right.length && left.every((value, index) => value.key === right[index]?.key && value.value === right[index]?.value);
	}

	private schedulePersist(priority: 'normal' | 'low'): void {
		if (this.persistQueued) return;
		this.persistQueued = true;
		this.scheduler.schedule(async () => {
			this.persistQueued = false;
			await this.persistIndex();
		}, priority);
	}

	private async persistIndex(): Promise<void> {
		try {
			const files = this.app.vault.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile).map((file) => ({ path: file.path, stat: file.stat }));
			const cache = this.cache;
			if (!cache) return;
			await cache.save({ schemaVersion: CACHE_SCHEMA_VERSION, files: this.index.serialize(), vaultFingerprint: createVaultFingerprint(files) });
		} catch (error) {
			console.warn('Vault Engine: cache save failed.', error);
		}
	}
}
