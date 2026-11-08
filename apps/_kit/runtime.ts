// The `gw` object: one host connection per page, with tool input/result buffered so late
// listeners still get them.
import { createShell, confirm, el, type Shell, type ConfirmOptions } from "../_shared/shell";
import type { Row } from "./data";

type Listener = (v: any) => void;

export interface Gateway {
  ready: Promise<void>;
  call<T = Row>(tool: string, args?: Record<string, unknown>): Promise<T>;
  onInput(fn: (args: Row) => void): void;
  onResult(fn: (structured: Row | undefined, isError: boolean) => void): void;
  input(): Row | undefined;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  setContext(text: string, structured?: Row): Promise<void>;
  openLink(url: string): void;
  el: typeof el;
}

export function createGateway(name: string): Gateway {
  let shell: Shell | undefined;
  let lastInput: Row | undefined;
  let lastResult: [Row | undefined, boolean] | undefined;
  const inputL: Listener[] = [];
  const resultL: ((s: Row | undefined, e: boolean) => void)[] = [];

  const ready = createShell({
    name,
    onToolInput: (a) => {
      lastInput = a;
      inputL.forEach((f) => f(a));
    },
    onToolResult: (s, e) => {
      lastResult = [s, e];
      resultL.forEach((f) => f(s, e));
    },
  }).then((s) => {
    shell = s;
  });

  return {
    ready,
    async call(tool, args = {}) {
      await ready;
      return shell!.call(tool, args);
    },
    onInput(fn) {
      inputL.push(fn);
      if (lastInput) fn(lastInput);
    },
    onResult(fn) {
      resultL.push(fn);
      if (lastResult) fn(...lastResult);
    },
    input: () => lastInput,
    confirm,
    async setContext(text, structured) {
      await ready;
      return shell!.setModelContext(text, structured);
    },
    openLink(url) {
      ready.then(() => shell!.openLink(url));
    },
    el,
  };
}
