import type { SNClient } from "../sn-client.js";
import { errorResult } from "./types.js";
import type { HandlerContext, HandlerRegistry } from "./types.js";
import { disp, isSysId, snToIso, str, toSNDateTime, val } from "./util.js";

export interface ApprovalRow {
  approval_sys_id: string;
  change_sys_id: string;
  number: string;
  short_description: string;
  type: string;
  risk: string;
  ci: string;
  start_date?: string;
  end_date?: string;
  on_behalf_of?: string;
  url: string;
}

const CHANGE_LIST_FIELDS = ["sys_id", "number", "short_description", "type", "risk", "cmdb_ci", "start_date", "end_date"];

const CHANGE_DETAIL_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "type",
  "state",
  "risk",
  "impact",
  "priority",
  "category",
  "cmdb_ci",
  "assignment_group",
  "assigned_to",
  "requested_by",
  "start_date",
  "end_date",
  "justification",
  "implementation_plan",
  "risk_impact_analysis",
  "backout_plan",
  "test_plan",
  "conflict_status",
];

// Users the caller may approve for: themselves plus anyone with an active approvals delegation to them.
export async function approverIdsFor(
  sn: SNClient,
  callerSysId: string,
  now = new Date()
): Promise<{ ids: string[]; names: Record<string, string> }> {
  const ts = toSNDateTime(now);
  const delegations = await sn.list(
    "sys_user_delegate",
    `delegate=${callerSysId}^approvals=true^starts<=${ts}^ends>=${ts}`,
    { fields: ["user"], limit: 50, displayValue: "all" }
  );
  const names: Record<string, string> = {};
  const ids = [callerSysId];
  for (const d of delegations) {
    const id = val(d.user);
    if (isSysId(id) && !ids.includes(id)) {
      ids.push(id);
      names[id] = disp(d.user);
    }
  }
  return { ids, names };
}

function url(sn: SNClient, table: string, sysId: string): string {
  return `${sn.instanceUrl}/${table}.do?sys_id=${sysId}`;
}

async function requireCaller(ctx: HandlerContext): Promise<string | undefined> {
  const id = await ctx.callerSysId();
  return isSysId(id) ? id : undefined;
}

export async function listApprovals(ctx: HandlerContext, limit: number): Promise<ApprovalRow[]> {
  const caller = await requireCaller(ctx);
  if (!caller) return [];
  const { ids, names } = await approverIdsFor(ctx.sn, caller);
  const approvals = await ctx.sn.list(
    "sysapproval_approver",
    `approverIN${ids.join(",")}^state=requested^source_table=change_request`,
    { fields: ["sys_id", "approver", "sysapproval"], limit: 200, displayValue: "all" }
  );
  if (approvals.length === 0) return [];

  const changeIds = [...new Set(approvals.map((a) => val(a.sysapproval)).filter(isSysId))];
  const changes = await ctx.sn.list("change_request", `sys_idIN${changeIds.join(",")}`, {
    fields: CHANGE_LIST_FIELDS,
    limit: changeIds.length,
    displayValue: "all",
  });
  const byId = new Map(changes.map((c) => [val(c.sys_id), c]));

  const rows: ApprovalRow[] = [];
  for (const a of approvals) {
    const c = byId.get(val(a.sysapproval));
    if (!c) continue;
    const approver = val(a.approver);
    rows.push({
      approval_sys_id: val(a.sys_id),
      change_sys_id: val(c.sys_id),
      number: disp(c.number),
      short_description: disp(c.short_description),
      type: disp(c.type),
      risk: disp(c.risk),
      ci: disp(c.cmdb_ci),
      start_date: snToIso(val(c.start_date)),
      end_date: snToIso(val(c.end_date)),
      on_behalf_of: approver !== caller ? names[approver] || disp(a.approver) : undefined,
      url: url(ctx.sn, "sysapproval_approver", val(a.sys_id)),
    });
  }
  rows.sort((x, y) => (x.start_date ?? "9999").localeCompare(y.start_date ?? "9999"));
  return rows.slice(0, limit);
}

// Loads an approval and checks the caller may act on it.
async function loadOwnedApproval(
  ctx: HandlerContext,
  approvalSysId: string
): Promise<{ approval: any; caller: string } | { error: "not_found" | "not_yours" | "no_identity" }> {
  const caller = await requireCaller(ctx);
  if (!caller) return { error: "no_identity" };
  const approval = await ctx.sn.get("sysapproval_approver", approvalSysId, {
    fields: ["sys_id", "approver", "state", "sysapproval", "source_table"],
  });
  if (!approval || approval.source_table !== "change_request") return { error: "not_found" };
  const approver = val(approval.approver);
  if (approver !== caller) {
    const { ids } = await approverIdsFor(ctx.sn, caller);
    if (!ids.includes(approver)) return { error: "not_yours" };
  }
  return { approval, caller };
}

const ERR_TEXT = {
  not_found: "That approval does not exist or is not a change approval.",
  not_yours: "That approval is not assigned to you or to anyone you are an active delegate for.",
  no_identity: "Could not resolve the caller to a ServiceNow user.",
};

export const approvalHandlers: HandlerRegistry = {
  "approvals.list": {
    async fn(args, ctx) {
      const limit = Math.min(Math.max(1, Number(args["limit"] ?? 25) || 25), 100);
      const approvals = await listApprovals(ctx, limit);
      const decisionsEnabled = ctx.caller.mode === "user";
      const identity = {
        mode: ctx.caller.mode,
        user: ctx.caller.displayName ?? ctx.caller.username,
        decisions_enabled: decisionsEnabled,
      };
      const lines = approvals.map(
        (a) =>
          `- ${a.number}: ${a.short_description} [${a.type}, risk ${a.risk || "?"}] CI ${a.ci || "-"}, ` +
          `${a.start_date ?? "?"} → ${a.end_date ?? "?"}${a.on_behalf_of ? ` (on behalf of ${a.on_behalf_of})` : ""}` +
          (ctx.appsClient ? "" : `\n  Approve or reject in ServiceNow: ${a.url}`)
      );
      const head = approvals.length
        ? `${approvals.length} change approval(s) waiting on ${identity.user}:`
        : `No change approvals are waiting on ${identity.user}.`;
      const tail = ctx.appsClient
        ? "The approver decides in the approvals app; you cannot approve or reject on their behalf."
        : "Decisions can't be recorded from this client; use the links above.";
      const warn = decisionsEnabled
        ? []
        : ["Note: this server uses a shared service account, so these are the service account's approvals and decisions are disabled."];
      return {
        text: [head, ...lines, "", tail, ...warn].join("\n"),
        structured: { approvals, identity },
      };
    },
  },

  "approvals.detail": {
    async fn(args, ctx) {
      const id = str(args["approval_sys_id"]);
      if (!isSysId(id)) return errorResult("bad_request", "approval_sys_id must be a sys_id");
      const owned = await loadOwnedApproval(ctx, id);
      if ("error" in owned) return errorResult(owned.error, ERR_TEXT[owned.error]);
      const changeId = val(owned.approval.sysapproval);

      const [change, cis, conflicts, history] = await Promise.all([
        ctx.sn.get("change_request", changeId, { fields: CHANGE_DETAIL_FIELDS, displayValue: "all" }),
        ctx.sn.list("task_ci", `task=${changeId}`, { fields: ["ci_item"], limit: 100, displayValue: "all" }),
        ctx.sn
          .list("conflict", `change=${changeId}`, {
            fields: ["type", "conflicting_change", "configuration_item", "schedule"],
            limit: 50,
            displayValue: "all",
          })
          .catch(() => []), // conflict table may be absent or restricted
        ctx.sn.list("sysapproval_approver", `sysapproval=${changeId}^ORDERBYsys_created_on`, {
          fields: ["sys_id", "approver", "state", "sys_updated_on"],
          limit: 100,
          displayValue: "all",
        }),
      ]);
      if (!change) return errorResult("not_found", "The change for this approval was not found.");

      const flat: Record<string, string> = {};
      for (const f of CHANGE_DETAIL_FIELDS) flat[f] = disp(change[f]);
      flat["sys_id"] = val(change.sys_id);
      flat["start_date_iso"] = snToIso(val(change.start_date)) ?? "";
      flat["end_date_iso"] = snToIso(val(change.end_date)) ?? "";
      flat["url"] = url(ctx.sn, "change_request", flat["sys_id"]!);

      const out = {
        approval: { sys_id: id, state: val(owned.approval.state) },
        change: flat,
        affected_cis: cis.map((c) => ({ sys_id: val(c.ci_item), name: disp(c.ci_item) })),
        conflicts: conflicts.map((c: any) => ({
          type: disp(c.type),
          conflicting_change: disp(c.conflicting_change),
          ci: disp(c.configuration_item),
          schedule: disp(c.schedule),
        })),
        history: history.map((h) => ({
          approver: disp(h.approver),
          state: val(h.state),
          state_label: disp(h.state),
          updated: snToIso(val(h.sys_updated_on)),
        })),
      };
      return {
        text:
          `${flat["number"]}: ${flat["short_description"]} (${flat["type"]}, risk ${flat["risk"]}, state ${flat["state"]}). ` +
          `Window ${flat["start_date"]} → ${flat["end_date"]}. ${out.affected_cis.length} affected CI(s), ` +
          `${out.conflicts.length} conflict(s).`,
        structured: out,
      };
    },
  },

  "approvals.decide": {
    write: true,
    async fn(args, ctx) {
      // A shared service account would record every decision as itself, breaking the audit
      // trail and separation of duties, so decisions need a per-user identity.
      if (ctx.caller.mode !== "user") {
        return errorResult(
          "identity_required",
          "Approval decisions require per-user ServiceNow identity; this server uses a shared service account."
        );
      }
      const id = str(args["approval_sys_id"]);
      const decision = str(args["decision"]);
      const comments = str(args["comments"]);
      if (!isSysId(id)) return errorResult("bad_request", "approval_sys_id must be a sys_id");
      if (decision !== "approved" && decision !== "rejected") {
        return errorResult("bad_request", "decision must be approved or rejected");
      }
      if (decision === "rejected" && !comments) {
        return errorResult("comments_required", "A comment is required to reject.");
      }
      if (comments && comments.length > 4000) return errorResult("bad_request", "Comment is too long");

      // Re-read just before writing: it may have been decided or reassigned elsewhere.
      const owned = await loadOwnedApproval(ctx, id);
      if ("error" in owned) {
        const code = owned.error === "not_found" ? "stale" : owned.error;
        return errorResult(code, ERR_TEXT[owned.error]);
      }
      if (owned.approval.state !== "requested") {
        return errorResult("stale", `This approval is already ${owned.approval.state}.`, {
          state: owned.approval.state,
        });
      }

      const body: Record<string, string> = { state: decision };
      if (comments) body["comments"] = comments;
      await ctx.sn.patch("sysapproval_approver", id, body);

      const change = await ctx.sn.get("change_request", val(owned.approval.sysapproval), { fields: ["number"] });
      const number = String(change?.number ?? "");
      const out = { number, decision, decided_at: new Date().toISOString() };
      return {
        text: `${ctx.caller.displayName ?? ctx.caller.username} ${decision} ${number}.`,
        structured: out,
        audit: { record: number, decision },
      };
    },
  },
};
