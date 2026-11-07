import { SNClient } from "../src/sn-client.js";
import type { HandlerContext } from "../src/handlers/index.js";
import type { FakeSN } from "./fake-sn.js";

export function ctxFor(
  sn: FakeSN,
  opts: { username?: string; password?: string; mode?: "service" | "user"; apps?: boolean } = {}
): HandlerContext {
  const username = opts.username ?? "admin";
  const password = opts.password ?? sn.users[username] ?? "admin";
  const client = new SNClient(() => ({ instanceUrl: sn.url, username, password }));
  const caller = { mode: opts.mode ?? "service", username } as HandlerContext["caller"];
  return {
    sn: client,
    caller,
    server: { id: "srv", name: "change-ops", description: "", port: 0, tools: [] },
    tool: { id: "t", name: "t", description: "", method: "POST", endpoint: "", apiType: "scripted", parameters: [] },
    sessionId: "s1",
    appsClient: opts.apps ?? true,
    async callerSysId() {
      if (caller.sysId) return caller.sysId;
      const rows = await client.list("sys_user", `user_name=${username}`, { fields: ["sys_id", "name"] });
      caller.sysId = rows[0]?.sys_id;
      caller.displayName = rows[0]?.name;
      return caller.sysId;
    },
  };
}

export function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}
