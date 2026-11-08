// App Kit: one prebuilt script that turns a JSON spec (form / view / approval) into an MCP
// App, and gives hand-written HTML apps a ready `window.gw` bridge to the gateway's tools.
// The gateway inlines it into the ui:// resource, so new apps need no build step.
import shellCss from "../_shared/shell.css?inline";
import kitCss from "./kit.css?inline";
import type { AppSpec } from "../../src/app-spec-types";
import { banner, el } from "../_shared/shell";
import * as data from "./data";
import { createGateway, type Gateway } from "./runtime";
import { renderForm } from "./render-form";
import { renderView } from "./render-view";
import { renderApproval } from "./render-approval";

function mount(gw: Gateway, target: HTMLElement, spec: AppSpec): void {
  if (spec.type === "form") renderForm(gw, target, spec);
  else if (spec.type === "view") renderView(gw, target, spec);
  else if (spec.type === "approval") renderApproval(gw, target, spec);
  else banner(target, "error", `Unknown app type: ${(spec as { type?: string }).type}`);
}

const style = document.createElement("style");
style.textContent = shellCss + kitCss;
(document.head ?? document.documentElement).prepend(style);

const specEl = document.getElementById("app-spec");
const spec = specEl ? (JSON.parse(specEl.textContent ?? "{}") as AppSpec) : undefined;
const gw = createGateway(spec?.title ?? document.title ?? "gateway-app");

(window as any).gw = Object.assign(gw, {
  mount: (target: HTMLElement, s: AppSpec) => mount(gw, target, s),
  data,
});

if (spec) {
  const root = document.getElementById("root") ?? document.body.appendChild(el("div", { id: "root" }));
  mount(gw, root, spec);
}
