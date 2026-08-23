/** Public surface of the Companion domain package. */

export * from "./domain/index.ts";
export * from "./ledger/index.ts";
export * from "./projection/project.ts";
export * from "./attention/engine.ts";
export * from "./feed/cards.ts";
export * from "./sync/sync-project.ts";

export * from "./ingest/github/types.ts";
export * from "./ingest/github/derive.ts";
export * from "./ingest/github/normalize.ts";
export * from "./ingest/github/client.ts";

export * from "./ingest/buildos/parse.ts";
export * from "./ingest/buildos/reconcile.ts";
export * from "./ingest/buildos/normalize.ts";
export * from "./ingest/buildos/detect.ts";

export * from "./ingest/checkpoint/validate.ts";
export * from "./ingest/checkpoint/normalize.ts";
