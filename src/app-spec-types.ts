// No-code MCP App specs, rendered in the browser by the App Kit (apps/_kit) and validated by
// the gateway (src/app-spec.ts). Shared by both, so this file has no imports.
//
// Templates: string values in `args` may contain {{path}} placeholders.
//   {{field}}        a field of the current row (approval card) or form value
//   {{input.field}}  an argument the model passed to the tool that opened the app
//   {{comment}}      the comment typed on an approval card
//   {{text}}         what the user typed in a lookup field
// A value that is exactly one placeholder keeps its type; empty results are dropped.

export type AppSpecType = "form" | "view" | "approval";

export interface DataSource {
  tool: string; // tool on the same server, called from the app
  args?: Record<string, unknown>;
  path?: string; // dot path to the rows array in structuredContent; default: first array found
}

export interface Choice {
  value: string;
  label?: string;
}

export interface LookupSpec {
  tool: string; // called with args, plus { [textArg]: <typed text> } unless args use {{text}}
  textArg?: string; // default "text"
  args?: Record<string, unknown>; // e.g. { "sysparm_query": "nameLIKE{{text}}^ORDERBYname", "sysparm_limit": 10 }
  path?: string; // rows array; default: first array found
  value?: string; // field stored in the form value; default "sys_id"
  label?: string; // field shown; default "name" (or "label")
  detail?: string; // optional secondary field
}

export type FieldType = "text" | "textarea" | "number" | "select" | "date" | "datetime" | "checkbox" | "lookup";

export interface FieldSpec {
  name: string; // argument name sent to the submit tool
  label?: string;
  type?: FieldType; // default "text"
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: (string | Choice)[]; // select
  lookup?: LookupSpec; // lookup
}

export interface ShowField {
  field: string; // dot path into the row / result
  label?: string;
}

export interface FormSpec {
  type: "form";
  title: string;
  description?: string;
  fields: FieldSpec[];
  submit: {
    tool: string;
    label?: string; // default "Submit"
    confirm?: boolean; // default true
    args?: Record<string, unknown>; // fixed extra args, templated
  };
  result?: {
    title?: string; // templated against the result, e.g. "Created {{result.number}}"
    fields?: ShowField[];
  };
}

export type ViewDisplay = "table" | "bar" | "stats";

export interface ViewSpec {
  type: "view";
  title: string;
  description?: string;
  source?: DataSource; // omitted: show the result of the tool that opened the app
  display: ViewDisplay;
  columns?: ShowField[]; // table; default: first 6 fields of the first row
  groupBy?: string; // bar / stats: count rows by this field
  limit?: number; // rows shown in a table; default 50
}

export interface ApprovalAction {
  label: string;
  tool: string;
  args: Record<string, unknown>; // templated per row, e.g. { "sys_id": "{{sys_id}}", "state": "approved" }
  style?: "primary" | "danger";
  comment?: "none" | "optional" | "required"; // default "none"
  confirm?: boolean; // default true
}

export interface ApprovalSpec {
  type: "approval";
  title: string;
  description?: string;
  source?: DataSource; // omitted: the result of the tool that opened the app
  titleField: string; // card heading, e.g. "number"
  subtitleField?: string;
  fields?: ShowField[];
  actions: ApprovalAction[];
  empty?: string; // message when there are no rows
}

export type AppSpec = FormSpec | ViewSpec | ApprovalSpec;
