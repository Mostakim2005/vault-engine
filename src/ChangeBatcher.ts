import { TFile } from 'obsidian';

export type FileChange =
	| { type: 'create'; file: TFile }
	| { type: 'modify'; file: TFile }
	| { type: 'rename'; file: TFile; oldPath: string }
	| { type: 'delete'; path: string };

export type ChangeFlushListener = (changes: readonly FileChange[]) => void;

const FLUSH_DELAY_MS = 50;

export class ChangeBatcher {
	private readonly pending = new Map<string, FileChange>();
	private timer: number | null = null;

	constructor(private readonly onFlush: ChangeFlushListener) {}

	push(change: FileChange): void {
		if (change.type === 'rename') {
			const existingOld = this.pending.get(change.oldPath);
			if (existingOld) {
				this.pending.delete(change.oldPath);
				change = this.merge(existingOld, change);
			}
		}

		const key = change.type === 'delete' ? change.path : change.file.path;
		const previous = this.pending.get(key);
		const merged = this.merge(previous, change);

		if (merged.type === 'delete') {
			this.pending.delete(key);
		} else {
			this.pending.set(key, merged);
		}

		this.schedule();
	}

	flushNow(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) return;

		const changes = [...this.pending.values()];
		this.pending.clear();
		this.onFlush(changes);
	}

	cancel(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.pending.clear();
	}

	private schedule(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => this.flushNow(), FLUSH_DELAY_MS);
	}

	private merge(previous: FileChange | undefined, next: FileChange): FileChange {
		if (!previous) return next;
		if (next.type === 'delete') return next;
		if (previous.type === 'create') return { type: 'create', file: next.file };
		if (previous.type === 'delete') return next;
		if (previous.type === 'rename') {
			return { type: 'rename', file: next.file, oldPath: previous.oldPath };
		}
		if (next.type === 'rename') return next;
		return { type: 'modify', file: next.file };
	}
}
