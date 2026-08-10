import { readNestSource, requireNestCodeIndex } from "./shared.js";
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
  options?: { max_gateways?: number },
): Promise<NestWebSocketMapResult> {
  const index = await requireNestCodeIndex(repo);

  const maxGateways = options?.max_gateways ?? 100;
  const gateways: NestGatewayEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const gatewayFiles = index.files.filter(
    (f) => f.path.endsWith(".gateway.ts") || f.path.endsWith(".gateway.js"),
  );

  for (const file of gatewayFiles) {
    if (gateways.length >= maxGateways) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Parse @WebSocketGateway decorator with optional port + options
    // Form 1: @WebSocketGateway()
    // Form 2: @WebSocketGateway(3001)
    // Form 3: @WebSocketGateway(3001, { namespace: '/chat' })
    // Form 4: @WebSocketGateway({ namespace: '/chat' })
    const wsGwRe = /@WebSocketGateway\s*\(([\s\S]*?)\)\s*(?:export\s+)?class\s+(\w+)/;
    const gwMatch = wsGwRe.exec(source);
    if (!gwMatch) continue;

    const gwArgs = gwMatch[1]!;
    const gatewayClass = gwMatch[2]!;

    const entry: NestGatewayEntry = {
      gateway_class: gatewayClass,
      file: file.path,
      events: [],
    };

    // Port — first integer literal in args
    // R-4 fix: only accept a leading bare integer as port (not nums inside namespace strings)
    const portMatch = /^\s*(\d+)\s*(?:,|\))/.exec(gwArgs);
    if (portMatch) entry.port = parseInt(portMatch[1]!, 10);

    // Namespace — from options object
    const nsMatch = /namespace:\s*['"`]([^'"`]+)['"`]/.exec(gwArgs);
    if (nsMatch) entry.namespace = nsMatch[1]!;

    // Find @SubscribeMessage handlers
    const subRe = /@SubscribeMessage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(source)) !== null) {
      entry.events.push({ event: sm[1]!, handler: sm[2]! });
    }

    gateways.push(entry);
  }

  return {
    gateways,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
