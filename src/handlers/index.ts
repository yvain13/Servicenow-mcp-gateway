import { demoHandlers } from "./demo.js";
import { changeHandlers } from "./change.js";
import { approvalHandlers } from "./approvals.js";
import type { HandlerDef, HandlerRegistry } from "./types.js";

export * from "./types.js";

// Code-backed tool handlers, referenced from store.json as { kind: "handler", handler: "<name>" }.
export const handlers: HandlerRegistry = {
  ...demoHandlers,
  ...changeHandlers,
  ...approvalHandlers,
};

export function getHandler(name: string | undefined): HandlerDef | undefined {
  return name ? handlers[name] : undefined;
}

export function handlerNames(): string[] {
  return Object.keys(handlers).sort();
}
