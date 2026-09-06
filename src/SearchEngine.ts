import type { SearchRequest, SearchResult } from '@navigation-suite/contracts';
import { compareNatural } from '@navigation-suite/shared';
import type { IndexedFile, VaultIndex } from './VaultIndex';

interface RankedResult {
	readonly path: string;
	readonly score: number;
}

export class SearchEngine {
	constructor(private readonly index: VaultIndex) {}

	search(request: SearchRequest): readonly SearchResult[] {
		const query = request.query.trim().toLocaleLowerCase();
		if (!query) return [];

		const requestedLimit = request.limit;
		const limit = requestedLimit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(requestedLimit));
		if (limit === 0) return [];

		const candidates = this.getCandidates(request);
		if (limit === Number.POSITIVE_INFINITY) {
			const results: SearchResult[] = [];
			for (const file of candidates) {
				const score = this.score(file, query);
				if (score > 0) results.push({ path: file.path, score });
			}
			results.sort((left, right) => right.score - left.score || compareNatural(left.path, right.path));
			return results;
		}

		const top = new TopResults(limit);
		for (const file of candidates) {
			const score = this.score(file, query);
			if (score > 0) top.push({ path: file.path, score });
		}
		return top.toSorted();
	}

	private getCandidates(request: SearchRequest): readonly IndexedFile[] {
		if (!request.sourceType || !request.sourceId) return this.index.getAllFiles();
		if (request.sourceType === 'tag') return this.resolvePaths(this.index.getFilesForTag(request.sourceId));
		if (request.sourceType === 'property') {
			const [key, value] = request.sourceId.split('\u0000', 2);
			if (!key || value === undefined) return [];
			return this.resolvePaths(this.index.getFilesForProperty(key, value));
		}

		const sourceId = request.sourceId;
		const prefix = sourceId.endsWith('/') ? sourceId : `${sourceId}/`;
		return this.index.getAllFiles().filter((file) => file.parentPath === sourceId || file.path.startsWith(prefix));
	}

	private resolvePaths(paths: readonly string[]): IndexedFile[] {
		const files: IndexedFile[] = [];
		for (const path of paths) {
			const file = this.index.getIndexedFile(path);
			if (file) files.push(file);
		}
		return files;
	}

	private score(file: IndexedFile, query: string): number {
		const title = file.name.toLocaleLowerCase();
		const path = file.path.toLocaleLowerCase();
		const alias = file.aliases.join(' ').toLocaleLowerCase();
		const tags = file.tags.join(' ').toLocaleLowerCase();
		if (title === query) return 100;
		if (title.startsWith(query)) return 80;
		if (title.includes(query)) return 60;
		if (alias.includes(query)) return 45;
		if (tags.includes(query)) return 35;
		if (path.includes(query)) return 25;
		return 0;
	}
}

class TopResults {
	private readonly heap: RankedResult[] = [];

	constructor(private readonly limit: number) {}

	push(result: RankedResult): void {
		if (this.heap.length < this.limit) {
			this.heap.push(result);
			this.bubbleUp(this.heap.length - 1);
			return;
		}

		const worst = this.heap[0];
		if (!worst || !this.isBetter(result, worst)) return;
		this.heap[0] = result;
		this.bubbleDown(0);
	}

	toSorted(): readonly SearchResult[] {
		return [...this.heap]
			.sort((left, right) => right.score - left.score || compareNatural(left.path, right.path))
			.map((result) => ({ path: result.path, score: result.score }));
	}

	private isBetter(left: RankedResult, right: RankedResult): boolean {
		return left.score > right.score || (left.score === right.score && compareNatural(left.path, right.path) < 0);
	}

	private isWorse(left: RankedResult, right: RankedResult): boolean {
		return left.score < right.score || (left.score === right.score && compareNatural(left.path, right.path) > 0);
	}

	private bubbleUp(index: number): void {
		let current = index;
		while (current > 0) {
			const parent = Math.floor((current - 1) / 2);
			const currentValue = this.heap[current];
			const parentValue = this.heap[parent];
			if (!currentValue || !parentValue || !this.isWorse(currentValue, parentValue)) break;
			const temp = this.heap[current]!;
			this.heap[current] = this.heap[parent]!;
			this.heap[parent] = temp;
			current = parent;
		}
	}

	private bubbleDown(index: number): void {
		let current = index;
		while (true) {
			const left = current * 2 + 1;
			const right = left + 1;
			let worst = current;
			const leftValue = this.heap[left];
			const worstValue = this.heap[worst];
			if (left < this.heap.length && leftValue && worstValue && this.isWorse(leftValue, worstValue)) worst = left;
			const rightValue = this.heap[right];
			const currentWorstValue = this.heap[worst];
			if (right < this.heap.length && rightValue && currentWorstValue && this.isWorse(rightValue, currentWorstValue)) worst = right;
			if (worst === current) break;
			const temp = this.heap[current]!;
			this.heap[current] = this.heap[worst]!;
			this.heap[worst] = temp;
			current = worst;
		}
	}
}
