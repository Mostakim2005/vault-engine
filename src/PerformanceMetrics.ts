export interface MetricSnapshot {
	readonly name: string;
	readonly durationMs: number;
	readonly recordedAt: number;
}

export interface MetricSummary {
	readonly name: string;
	readonly count: number;
	readonly averageMs: number;
	readonly maxMs: number;
}

export class PerformanceMetrics {
	private readonly samples = new Map<string, MetricSnapshot[]>();

	measure<T>(name: string, operation: () => T): T {
		const start = performance.now();
		try {
			return operation();
		} finally {
			this.record(name, performance.now() - start);
		}
	}

	record(name: string, durationMs: number): void {
		const samples = this.samples.get(name) ?? [];
		samples.push({ name, durationMs, recordedAt: Date.now() });
		if (samples.length > 100) samples.shift();
		this.samples.set(name, samples);
	}

	getRecent(name: string): readonly MetricSnapshot[] {
		return this.samples.get(name) ?? [];
	}

	getSummary(name: string): MetricSummary {
		const samples = this.samples.get(name) ?? [];
		if (samples.length === 0) return { name, count: 0, averageMs: 0, maxMs: 0 };
		const total = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
		return {
			name,
			count: samples.length,
			averageMs: total / samples.length,
			maxMs: Math.max(...samples.map((sample) => sample.durationMs)),
		};
	}

	getAllSummaries(): readonly MetricSummary[] {
		return [...this.samples.keys()].sort().map((name) => this.getSummary(name));
	}
}
