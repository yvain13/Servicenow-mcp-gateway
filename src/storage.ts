import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { Store, MCPServer, Tool, InstanceConfig } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dir, "../data/store.json");

const EMPTY: Store = { instance: null, servers: [] };

function read(): Store {
  if (!existsSync(DATA_FILE)) return structuredClone(EMPTY);
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf8")) as Store;
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(store: Store): void {
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ── Instance ──────────────────────────────────────────────────────────────────

export function getInstance(): InstanceConfig | null {
  return read().instance;
}

export function setInstance(cfg: InstanceConfig): void {
  const store = read();
  store.instance = cfg;
  write(store);
}

// ── Servers ───────────────────────────────────────────────────────────────────

export function listServers(): MCPServer[] {
  return read().servers;
}

export function getServer(id: string): MCPServer | undefined {
  return read().servers.find((s) => s.id === id);
}

export function createServer(
  data: Omit<MCPServer, "id" | "tools">
): MCPServer {
  const store = read();
  const server: MCPServer = { ...data, id: randomUUID(), tools: [] };
  store.servers.push(server);
  write(store);
  return server;
}

export function deleteServer(id: string): boolean {
  const store = read();
  const before = store.servers.length;
  store.servers = store.servers.filter((s) => s.id !== id);
  write(store);
  return store.servers.length < before;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export function listTools(serverId: string): Tool[] {
  return getServer(serverId)?.tools ?? [];
}

export function getTool(serverId: string, toolId: string): Tool | undefined {
  return listTools(serverId).find((t) => t.id === toolId);
}

export function getToolByName(serverId: string, name: string): Tool | undefined {
  return listTools(serverId).find((t) => t.name === name);
}

export function addTool(serverId: string, data: Omit<Tool, "id">): Tool {
  const store = read();
  const server = store.servers.find((s) => s.id === serverId);
  if (!server) throw new Error(`Server ${serverId} not found`);
  const tool: Tool = { ...data, id: randomUUID() };
  server.tools.push(tool);
  write(store);
  return tool;
}

export function updateTool(
  serverId: string,
  toolId: string,
  patch: Partial<Omit<Tool, "id">>
): Tool {
  const store = read();
  const server = store.servers.find((s) => s.id === serverId);
  if (!server) throw new Error(`Server ${serverId} not found`);
  const idx = server.tools.findIndex((t) => t.id === toolId);
  if (idx === -1) throw new Error(`Tool ${toolId} not found`);
  server.tools[idx] = { ...server.tools[idx], ...patch };
  write(store);
  return server.tools[idx];
}

export function deleteTool(serverId: string, toolId: string): boolean {
  const store = read();
  const server = store.servers.find((s) => s.id === serverId);
  if (!server) return false;
  const before = server.tools.length;
  server.tools = server.tools.filter((t) => t.id !== toolId);
  write(store);
  return server.tools.length < before;
}
