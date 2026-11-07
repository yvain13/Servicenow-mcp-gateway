import { createShell, el, banner, errorMessage } from "../_shared/shell";

const root = document.getElementById("root")!;
const status = el("div");
const input = el("input", { placeholder: "Type a message", value: "hello from the app" }) as HTMLInputElement;
const send = el("button", { class: "primary", type: "button" }, "Call hello_echo");
const out = el("pre", { class: "card mono" }, "No call yet.");
const greeting = el("h1", {}, "Hello app");
root.append(greeting, status, el("div", { class: "row" }, input, send), el("h2", {}, "structuredContent"), out);

const shell = await createShell({
  name: "gateway-hello",
  onToolResult: (s) => {
    if (s?.["name"]) greeting.textContent = `Hello, ${s["name"]}!`;
  },
});
banner(status, "ok", "Connected to the host.");

send.onclick = async () => {
  send.disabled = true;
  try {
    const res = await shell.call("hello_echo", { message: input.value });
    out.textContent = JSON.stringify(res, null, 2);
  } catch (err) {
    banner(status, "error", errorMessage(err));
  } finally {
    send.disabled = false;
  }
};
