import type { HandlerRegistry } from "./types.js";

// Phase 1 sample: proves a ui:// resource renders, and that the app can call an app-only
// tool and receive structuredContent. No ServiceNow calls.
export const demoHandlers: HandlerRegistry = {
  "demo.open_hello": {
    async fn(args, ctx) {
      const name = String(args["name"] ?? "there");
      return {
        text: ctx.appsClient
          ? `Opened the hello app for ${name}.`
          : `Hello, ${name}! (This client does not render MCP Apps, so this is the text fallback.)`,
        structured: { name, server: ctx.server.name, caller: ctx.caller.username },
      };
    },
  },
  "demo.echo": {
    async fn(args, ctx) {
      const message = String(args["message"] ?? "");
      return {
        text: `echo: ${message}`,
        structured: {
          message,
          reversed: [...message].reverse().join(""),
          at: new Date().toISOString(),
          caller: ctx.caller.username,
        },
      };
    },
  },
};
