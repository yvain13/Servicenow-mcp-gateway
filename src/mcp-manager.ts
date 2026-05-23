import { MCPInstance } from "./mcp-instance.js";
import type { SNCredentials } from "./servicenow.js";
import type { MCPServer } from "./types.js";

export class MCPManager {
  private instances: Map<string, MCPInstance> = new Map();
  private creds: SNCredentials;

  constructor(creds: SNCredentials) {
    this.creds = creds;
  }

  updateCreds(creds: SNCredentials): void {
    this.creds = creds;
  }

  async start(server: MCPServer): Promise<void> {
    if (this.instances.has(server.id)) return; // already running
    const inst = new MCPInstance(server, this.creds);
    await inst.start();
    this.instances.set(server.id, inst);
  }

  async stop(serverId: string): Promise<void> {
    const inst = this.instances.get(serverId);
    if (!inst) return;
    await inst.stop();
    this.instances.delete(serverId);
  }

  async restart(server: MCPServer): Promise<void> {
    await this.stop(server.id);
    await this.start(server);
  }

  isRunning(serverId: string): boolean {
    return this.instances.has(serverId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
  }

  runningIds(): string[] {
    return [...this.instances.keys()];
  }
}
