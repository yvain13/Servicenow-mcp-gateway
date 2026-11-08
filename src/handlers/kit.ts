import type { HandlerRegistry } from "./types.js";

// Generic launcher for no-code apps: opens the app the tool is linked to (ui.resourceUri)
// and passes the model's arguments through as tool input / structuredContent for prefill.
export const kitHandlers: HandlerRegistry = {
  "app.open": {
    async fn(args, ctx) {
      const app = (ctx.server.apps ?? []).find((a) => a.uri === ctx.tool.ui?.resourceUri);
      const name = app?.name ?? ctx.tool.name;
      const given = Object.entries(args).filter(([, v]) => v !== undefined && v !== "");
      if (ctx.appsClient) {
        return {
          text: `Opened "${name}" for the user.${given.length ? ` Prefilled: ${given.map(([k]) => k).join(", ")}.` : ""} The user completes it in the app.`,
          structured: { ...args },
        };
      }
      const spec = app?.spec;
      let detail = "";
      if (spec?.type === "form") {
        detail = ` Its fields: ${spec.fields.map((f) => `${f.name}${f.required ? " (required)" : ""}`).join(", ")}. Submit tool: ${spec.submit.tool}.`;
      }
      return {
        text: `"${name}" is an interactive app, and this client does not render MCP Apps.${detail}`,
        structured: { ...args },
      };
    },
  },
};
