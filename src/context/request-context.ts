import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  correlationId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T
): T {
  return requestContext.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getCorrelationId(): string {
  return getRequestContext()?.correlationId ?? "unknown";
}
