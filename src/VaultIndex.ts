import { App, CachedMetadata, TAbstractFile, TFile, TFolder, getAllTags } from 'obsidian';
import type { FileRecord, FolderChildren } from '@navigation-suite/contracts';
import { compareNatural, normalizePath } from '@navigation-suite/shared';

export interface IndexedProperty {
	readonly key: string;
	readonly value: string;
}

export interface IndexedFile extends FileRecord {
	readonly properties: readonly IndexedProperty[];
}

export class VaultIndex {
	private readonly files = new Map<string, IndexedFile>();
	private readonly folderChildren = new Map<string, { folders: Set<string>; files: Set<string> }>();
	private readonly tagFiles = new Map<string, Set<string>>();
	private readonly propertyFiles = new Map<string, Set<string>>();
	private readonly folderChildrenCache = new Map<string, { version: number; value: FolderChildren }>();
	private readonly tagFilesCache = new Map<string, { version: number; value: readonly string[] }>();
	private readonly propertyFilesCache = new Map<string, { version: number; value: readonly string[] }>();
	private sortedTagsCache: { version: number; value: readonly string[] } | null = null;
	private allFilesCache: { version: number; value: readonly IndexedFile[] } | null = null;
	private version = 0;

	constructor(private readonly app: App) {}

	clear(): void {
		this.files.clear();
		this.folderChildren.clear();
		this.tagFiles.clear();
		this.propertyFiles.clear();
		this.invalidateCaches();
	}

	rebuild(): void {
		this.clear();
		for (const file of this.app.vault.getAllLoadedFiles()) {
			this.indexAbstractFile(file);
		}
	}

	upsert(file: TFile): void {
		this.remove(file.path, false);
		this.indexAbstractFile(file);
		this.bumpVersion();
	}

	upsertFolder(folder: TFolder): void {
		this.removeFolder(folder.path, false);
		const folderPath = normalizePath(folder.path);
		this.ensureFolder(folderPath);
		if (folder.parent) this.addToFolderChildren(normalizePath(folder.parent.path), folderPath, true);
		this.bumpVersion();
	}

	removeFolder(path: string, bumpVersion = true): void {
		const normalized = normalizePath(path);
		const folder = this.folderChildren.get(normalized);
		if (!folder) return;
		for (const childFolder of [...folder.folders]) this.removeFolder(childFolder, false);
		for (const childFile of [...folder.files]) this.remove(childFile, false);
		const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
		this.folderChildren.get(parent)?.folders.delete(normalized);
		this.folderChildren.delete(normalized);
		if (bumpVersion) this.bumpVersion();
	}

	remove(path: string, bumpVersion = true): void {
		const normalized = normalizePath(path);
		const existing = this.files.get(normalized);
		if (existing) {
			this.files.delete(normalized);
			const parent = existing.parentPath ?? '';
			this.folderChildren.get(parent)?.files.delete(normalized);
			this.removeSetMembership(this.tagFiles, normalized, existing.tags);
			this.removeSetMembership(this.propertyFiles, normalized, existing.properties.map((property) => this.propertyKey(property.key, property.value)));
			if (bumpVersion) this.bumpVersion();
			return;
		}
		const folder = this.folderChildren.get(normalized);
		if (!folder) return;
		const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
		this.folderChildren.get(parent)?.folders.delete(normalized);
		this.folderChildren.delete(normalized);
		if (bumpVersion) this.bumpVersion();
	}

	move(oldPath: string, file: TFile): void {
		this.remove(oldPath, false);
		this.indexAbstractFile(file);
		this.bumpVersion();
	}

	renameFolder(oldPath: string, newPath: string): boolean {
		const oldRoot = normalizePath(oldPath);
		const newRoot = normalizePath(newPath);
		if (oldRoot === newRoot) return false;
		const folderExists = this.folderChildren.has(oldRoot);
		if (!folderExists) return false;

		const folderEntries = [...this.folderChildren.entries()].filter(([path]) => path === oldRoot || path.startsWith(`${oldRoot}/`));
		const oldParent = oldRoot.includes('/') ? oldRoot.slice(0, oldRoot.lastIndexOf('/')) : '';
		this.folderChildren.get(oldParent)?.folders.delete(oldRoot);
		const fileEntries = [...this.files.entries()].filter(([path]) => path === oldRoot || path.startsWith(`${oldRoot}/`));

		for (const [path] of folderEntries) this.folderChildren.delete(path);
		for (const [path, record] of fileEntries) {
			this.files.delete(path);
			this.folderChildren.get(record.parentPath ?? '')?.files.delete(path);
			for (const tag of record.tags) this.tagFiles.get(tag)?.delete(path);
			for (const property of record.properties) this.propertyFiles.get(this.propertyKey(property.key, property.value))?.delete(path);
		}

		const renamedFolders = folderEntries.map(([path, children]) => {
			const nextPath = this.replacePrefix(path, oldRoot, newRoot);
			return {
				path: nextPath,
				folders: new Set([...children.folders].map((child) => this.replacePrefix(child, oldRoot, newRoot))),
				files: new Set([...children.files].map((child) => this.replacePrefix(child, oldRoot, newRoot))),
			};
		});
		for (const entry of renamedFolders) this.folderChildren.set(entry.path, entry);

		const renamedFiles = fileEntries.map(([path, record]) => {
			const nextPath = this.replacePrefix(path, oldRoot, newRoot);
			const parentPath = record.parentPath ? this.replacePrefix(record.parentPath, oldRoot, newRoot) : null;
			return { path: nextPath, record: { ...record, path: nextPath, parentPath } };
		});
		for (const { path, record } of renamedFiles) {
			this.files.set(path, record);
			this.addToFolderChildren(record.parentPath ?? '', path, false);
			for (const tag of record.tags) this.addToSet(this.tagFiles, tag, path);
			for (const property of record.properties) this.addToSet(this.propertyFiles, this.propertyKey(property.key, property.value), path);
		}

		const parent = newRoot.includes('/') ? newRoot.slice(0, newRoot.lastIndexOf('/')) : '';
		this.addToFolderChildren(parent, newRoot, true);
		this.bumpVersion();
		return true;
	}

	getFile(path: string): FileRecord | null {
		return this.files.get(normalizePath(path)) ?? null;
	}

	getIndexedFile(path: string): IndexedFile | null {
		return this.files.get(normalizePath(path)) ?? null;
	}

	getFolderChildren(path: string): FolderChildren {
		const normalized = normalizePath(path);
		const cached = this.folderChildrenCache.get(normalized);
		if (cached?.version === this.version) return cached.value;

		const children = this.folderChildren.get(normalized);
		const value: FolderChildren = children
			? { folders: [...children.folders].sort(compareNatural), files: [...children.files].sort(compareNatural) }
			: { folders: [], files: [] };
		this.folderChildrenCache.set(normalized, { version: this.version, value });
		return value;
	}

	getFilesForTag(tag: string): readonly string[] {
		const cached = this.tagFilesCache.get(tag);
		if (cached?.version === this.version) return cached.value;
		const value = [...(this.tagFiles.get(tag) ?? [])].sort(compareNatural);
		this.tagFilesCache.set(tag, { version: this.version, value });
		return value;
	}

	getAllTags(): readonly string[] {
		if (this.sortedTagsCache?.version === this.version) return this.sortedTagsCache.value;
		const value = [...this.tagFiles.keys()].sort(compareNatural);
		this.sortedTagsCache = { version: this.version, value };
		return value;
	}

	getFilesForProperty(key: string, value: string): readonly string[] {
		const indexKey = this.propertyKey(key, value);
		const cached = this.propertyFilesCache.get(indexKey);
		if (cached?.version === this.version) return cached.value;
		const result = [...(this.propertyFiles.get(indexKey) ?? [])].sort(compareNatural);
		this.propertyFilesCache.set(indexKey, { version: this.version, value: result });
		return result;
	}

	getAllFiles(): readonly IndexedFile[] {
		if (this.allFilesCache?.version === this.version) return this.allFilesCache.value;
		const value = [...this.files.values()];
		this.allFilesCache = { version: this.version, value };
		return value;
	}

	serialize(): IndexedFile[] {
		return [...this.files.values()];
	}

	restore(records: readonly IndexedFile[]): void {
		this.clear();
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder) {
				this.ensureFolder(normalizePath(file.path));
				if (file.parent) this.addToFolderChildren(normalizePath(file.parent.path), normalizePath(file.path), true);
			}
		}
		for (const record of records) {
			this.files.set(record.path, record);
			this.addToFolderChildren(record.parentPath ?? '', record.path, false);
			for (const tag of record.tags) this.addToSet(this.tagFiles, tag, record.path);
			for (const property of record.properties) this.addToSet(this.propertyFiles, this.propertyKey(property.key, property.value), record.path);
		}
		this.bumpVersion();
	}

	private indexAbstractFile(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			const folderPath = normalizePath(file.path);
			this.ensureFolder(folderPath);
			if (file.parent) this.addToFolderChildren(normalizePath(file.parent.path), folderPath, true);
			return;
		}
		if (file instanceof TFile) {
			const record = this.createRecord(file);
			this.files.set(record.path, record);
			this.addToFolderChildren(record.parentPath ?? '', record.path, false);
			for (const tag of record.tags) this.addToSet(this.tagFiles, tag, record.path);
			for (const property of record.properties) this.addToSet(this.propertyFiles, this.propertyKey(property.key, property.value), record.path);
		}
	}

	private createRecord(file: TFile): IndexedFile {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = this.extractTags(cache);
		const properties = this.extractProperties(cache);
		return {
			path: normalizePath(file.path),
			name: file.basename,
			extension: file.extension,
			parentPath: file.parent ? normalizePath(file.parent.path) : null,
			created: file.stat.ctime,
			modified: file.stat.mtime,
			tags,
			aliases: this.extractAliases(cache),
			properties,
		};
	}

	private extractTags(cache: CachedMetadata | null): string[] {
		if (!cache) return [];
		const tags = getAllTags(cache) ?? [];
		return [...new Set(tags.map((tag) => tag.startsWith('#') ? tag.slice(1) : tag))].sort(compareNatural);
	}

	private extractAliases(cache: CachedMetadata | null): string[] {
		const aliases = cache?.frontmatter?.aliases;
		if (!Array.isArray(aliases)) return [];
		return aliases.filter((value): value is string => typeof value === 'string');
	}

	private extractProperties(cache: CachedMetadata | null): IndexedProperty[] {
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) return [];
		return Object.entries(frontmatter)
			.filter(([key]) => key !== 'tags' && key !== 'aliases' && !key.startsWith('position-'))
			.map(([key, value]) => ({ key, value: this.normalizePropertyValue(value) }))
			.filter((property) => property.value.length > 0)
			.sort((left, right) => compareNatural(left.key, right.key));
	}

	private normalizePropertyValue(value: unknown): string {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean').map(String).join(', ');
		return '';
	}

	private bumpVersion(): void {
		this.version += 1;
		this.invalidateCaches();
	}

	private invalidateCaches(): void {
		this.folderChildrenCache.clear();
		this.tagFilesCache.clear();
		this.propertyFilesCache.clear();
		this.sortedTagsCache = null;
		this.allFilesCache = null;
	}

	private replacePrefix(path: string, oldPrefix: string, newPrefix: string): string {
		return path === oldPrefix ? newPrefix : path.startsWith(`${oldPrefix}/`) ? `${newPrefix}${path.slice(oldPrefix.length)}` : path;
	}

	private ensureFolder(path: string): void {
		if (!this.folderChildren.has(path)) this.folderChildren.set(path, { folders: new Set(), files: new Set() });
	}

	private addToFolderChildren(parent: string, child: string, isFolder: boolean): void {
		this.ensureFolder(parent);
		const children = this.folderChildren.get(parent);
		if (!children) return;
		if (isFolder) children.folders.add(child);
		else children.files.add(child);
	}

	private addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
		const values = map.get(key) ?? new Set<string>();
		values.add(value);
		map.set(key, values);
	}

	private removeSetMembership(map: Map<string, Set<string>>, value: string, keys: readonly string[]): void {
		for (const key of keys) {
			const values = map.get(key);
			if (!values) continue;
			values.delete(value);
			if (values.size === 0) map.delete(key);
		}
	}

	private propertyKey(key: string, value: string): string {
		return `${key}\u0000${value}`;
	}
}
