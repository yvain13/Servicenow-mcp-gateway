import { el } from "./shell";

export interface Option {
  sys_id: string;
  label: string;
  detail?: string;
  [k: string]: unknown;
}

// Debounced search box that resolves free text to a record (sys_id).
export class Typeahead {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private menu: HTMLElement;
  private timer: number | undefined;
  private seq = 0;
  selected: Option | null = null;
  onselect: (o: Option | null) => void = () => {};

  constructor(
    private readonly search: (text: string) => Promise<Option[]>,
    placeholder = "Search…"
  ) {
    this.input = el("input", { placeholder, autocomplete: "off" }) as HTMLInputElement;
    this.menu = el("div", { class: "menu", hidden: "" });
    this.root = el("div", { class: "typeahead" }, this.input, this.menu);
    this.input.addEventListener("input", () => {
      if (this.selected) this.set(null);
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(this.input.value), 250);
    });
    this.input.addEventListener("focus", () => this.input.value || this.run(""));
    this.input.addEventListener("blur", () => window.setTimeout(() => (this.menu.hidden = true), 150));
  }

  set(o: Option | null): void {
    this.selected = o;
    if (o) this.input.value = o.label;
    this.menu.hidden = true;
    this.onselect(o);
  }

  setDisabled(d: boolean): void {
    this.input.disabled = d;
  }

  // Resolve a name from the prefill: auto-select an exact (or single) match.
  async resolve(text: string): Promise<void> {
    this.input.value = text;
    const results = await this.search(text).catch(() => []);
    const exact = results.filter((r) => r.label.toLowerCase() === text.toLowerCase());
    if (exact.length === 1) this.set(exact[0]!);
    else if (results.length === 1) this.set(results[0]!);
  }

  private async run(text: string): Promise<void> {
    const mine = ++this.seq;
    const results = await this.search(text).catch(() => []);
    if (mine !== this.seq) return;
    this.menu.replaceChildren(
      ...(results.length
        ? results.map((r) => {
            const item = el("div", {}, r.label, ...(r.detail ? [el("small", {}, r.detail)] : []));
            item.addEventListener("mousedown", (e) => {
              e.preventDefault();
              this.set(r);
            });
            return item;
          })
        : [el("div", { class: "muted" }, "No matches")])
    );
    this.menu.hidden = false;
  }
}
