import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { Store, MCPServer, Tool, InstanceConfig } from "./types.js";
import { DATA_DIR, SEED_DIR } from "./paths.js";

// STORE_FILE overrides the location (used by tests).
const DATA_FILE = process.env["STORE_FILE"] ?? join(DATA_DIR, "store.json");

// Uploaded HTML apps live next to the store: <store dir>/apps/<serverId>/<slug>.html
export const STORE_DIR = dirname(DATA_FILE);
export const APPS_DATA_DIR = join(STORE_DIR, "apps");

// Starter servers, used until the first save creates data/store.json (which is not tracked).
const SEED_FILE = join(SEED_DIR, "store.seed.json");
const EMPTY: Store = { instance: null, servers: [] };

function readSeed(): Store | null {
  if (process.env["STORE_FILE"] || !existsSync(SEED_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SEED_FILE, "utf8")) as Store;
  } catch {
    return null;
  }
}

function stripSeedMeta(server: MCPServer): MCPServer {
  const { addedIn: _addedIn, ...rest } = server;
  return rest;
}

// Adds built-in servers introduced after this store was created (e.g. service-catalog), once.
// Stores from before `seeded` existed are treated as having been offered every seed server
// without an `addedIn` version. A server whose id, name or port is already taken is skipped.
export function mergeNewSeeds(store: Store, seed: Store): boolean {
  const offered = new Set(store.seeded ?? seed.servers.filter((s) => !s.addedIn).map((s) => s.id));
  let changed = store.seeded === undefined;
  for (const s of seed.servers) {
    if (offered.has(s.id)) continue;
    offered.add(s.id);
    changed = true;
    const clash = store.servers.some((x) => x.id === s.id || x.name === s.name || x.port === s.port);
    if (!clash) store.servers.push(stripSeedMeta(s));
  }
  store.seeded = [...offered];
  return changed;
}

function read(): Store {
  const seed = readSeed();
  if (!existsSync(DATA_FILE)) {
    if (!seed) return structuredClone(EMPTY);
    return { ...seed, servers: seed.servers.map(stripSeedMeta), seeded: seed.servers.map((s) => s.id) };
  }
  let store: Store;
  try {
    store = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Store;
  } catch {
    return structuredClone(EMPTY);
  }
  if (seed && mergeNewSeeds(store, seed)) write(store);
  return store;
}

function write(store: Store): void {
  mkdirSync(STORE_DIR, { recursive: true });
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

export function updateServer(
  id: string,
  patch: Partial<Pick<MCPServer, "description" | "appsEnabled" | "apps" | "identity" | "oauthCredential">>
): MCPServer {
  const store = read();
  const server = store.servers.find((s) => s.id === id);
  if (!server) throw new Error(`Server ${id} not found`);
  Object.assign(server, patch);
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
