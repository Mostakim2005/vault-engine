# Vault Engine

> **Status:** Kept for documentation. Backend of the Navigation Suite — see `navigator` and `power-tools`.

Incremental vault indexing, caching, metadata, and search engine.

## Intended features (from manifest + src)

- **VaultIndex** (`src/VaultIndex.ts`): incremental index
- **IndexedDbCache** (`src/IndexedDbCache.ts`): persistent cache
- **SearchEngine** (`src/SearchEngine.ts`): fast search
- **VaultEngineService** (`src/VaultEngineService.ts`): service layer for Navigator
- **ChangeBatcher / TaskScheduler / PerformanceMetrics**: batched updates + perf tracking
- No local mirror — functionality now covered by Obsidian core / Dataview

## License

Code is licensed under the PolyForm Noncommercial License 1.0.0 (see LICENSE). Documentation is under CC BY-NC 4.0. Free non-commercial use with credit, no commercial use.

Copyright © Mostakim2005 (GitHub) / Mostakim 4 Argon
