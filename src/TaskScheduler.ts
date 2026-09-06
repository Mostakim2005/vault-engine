export type TaskPriority = 'high' | 'normal' | 'low' | 'idle';

type QueueTask = {
	readonly sequence: number;
	readonly run: () => void | Promise<void>;
};

const PRIORITIES: readonly TaskPriority[] = ['high', 'normal', 'low', 'idle'];

/** Small cooperative scheduler for non-urgent vault work. */
export class TaskScheduler {
	private readonly queues: Record<TaskPriority, QueueTask[]> = {
		high: [],
		normal: [],
		low: [],
		idle: [],
	};
	private sequence = 0;
	private scheduled = false;
	private disposed = false;
	private idleHandle: number | null = null;
	private timerHandle: number | null = null;

	schedule(run: () => void | Promise<void>, priority: TaskPriority = 'normal'): void {
		if (this.disposed) return;
		this.queues[priority].push({ sequence: this.sequence++, run });
		this.requestDrain();
	}

	clear(): void {
		for (const priority of PRIORITIES) this.queues[priority].length = 0;
	}

	dispose(): void {
		this.disposed = true;
		this.clear();
		if (this.idleHandle !== null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
			window.cancelIdleCallback(this.idleHandle);
			this.idleHandle = null;
		}
		if (this.timerHandle !== null) {
			window.clearTimeout(this.timerHandle);
			this.timerHandle = null;
		}
		this.scheduled = false;
	}

	private requestDrain(): void {
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;

		const callback = () => {
			this.scheduled = false;
			this.idleHandle = null;
			this.timerHandle = null;
			void this.drain();
		};

		if (this.hasPending('high') || this.hasPending('normal')) {
			this.timerHandle = window.setTimeout(callback, 0);
			return;
		}

		if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
			this.idleHandle = window.requestIdleCallback(callback, { timeout: 250 });
		} else {
			this.timerHandle = window.setTimeout(callback, 0);
		}
	}

	private async drain(): Promise<void> {
		if (this.disposed) return;
		const task = this.takeNext();
		if (!task) return;
		try {
			await task.run();
		} catch (error) {
			console.warn('Vault Engine background task failed.', error);
		}
		if (this.hasPendingTasks()) this.requestDrain();
	}

	private takeNext(): QueueTask | undefined {
		for (const priority of PRIORITIES) {
			const queue = this.queues[priority];
			const task = queue.shift();
			if (task) return task;
		}
		return undefined;
	}

	private hasPending(priority: TaskPriority): boolean {
		return this.queues[priority].length > 0;
	}

	private hasPendingTasks(): boolean {
		return PRIORITIES.some((priority) => this.queues[priority].length > 0);
	}
}
