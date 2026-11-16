// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { AsyncLocalStorage } from "node:async_hooks";

/*
 * #14: which request the current async work belongs to. Set by exposeRequestId (http-logging.ts)
 * for the lifetime of a request, read by the logger (to stamp requestId on lines written through
 * module loggers), by outbound request-id forwarding, and by error tracking.
 */
export interface RequestContext {
  requestId: string;
  /** The service handling the request; the all-in-one process runs several. */
  service?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The id of the request being handled, if any (undefined outside a request). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
