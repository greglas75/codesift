import {
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  findNestMethodAfter,
  isNodeModulesPath,
  readNestSource,
  requireNestCodeIndex,
} from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// G6: nest_websocket_map — WebSocket gateway discovery
// ---------------------------------------------------------------------------

export interface NestGatewayEntry {
  gateway_class: string;
  file: string;
  port?: number;
  namespace?: string;
  events: Array<{ event: string; handler: string }>;
}

export interface NestWebSocketMapResult {
  gateways: NestGatewayEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestWebSocketMap(
  repo: string,
  options?: { max_gateways?: number; max_files_scanned?: number },
): Promise<NestWebSocketMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxGateways = options?.max_gateways ?? 100;
  const maxFilesScanned = options?.max_files_scanned ?? 2000;
  const gateways: NestGatewayEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const gatewayFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    return !isNodeModulesPath(f.path);
  });

  let scanned = 0;
  for (const file of gatewayFiles) {
    if (scanned >= maxFilesScanned) { truncated = true; break; }
    if (gateways.length >= maxGateways) { truncated = true; break; }
    scanned++;
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;
    if (!/@WebSocketGateway/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    for (const call of findDecoratorCalls(source, "WebSocketGateway")) {
      const owner = findDecoratedClass(classRanges, call);
      if (!owner) continue;
      if (gateways.length >= maxGateways) { truncated = true; break; }

      const entry: NestGatewayEntry = {
        gateway_class: owner.name,
        file: file.path,
        events: [],
      };

      const portMatch = /^\s*(\d+)\s*(?:,|$)/.exec(call.args);
      if (portMatch) entry.port = parseInt(portMatch[1]!, 10);

      const nsMatch = /namespace:\s*['"`]([^'"`]+)['"`]/.exec(call.args);
      if (nsMatch) entry.namespace = nsMatch[1]!;

      for (const subscribeCall of findDecoratorCalls(source, "SubscribeMessage")) {
        if (subscribeCall.start < owner.bodyStart || subscribeCall.start >= owner.end) continue;
        const event = /^\s*['"`]([^'"`]+)['"`]/.exec(subscribeCall.args)?.[1];
        const method = findNestMethodAfter(source, subscribeCall.end);
        if (!event || !method || method.start >= owner.end) continue;
        entry.events.push({ event, handler: method.name });
      }

      gateways.push(entry);
    }
  }

  return {
    gateways,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
