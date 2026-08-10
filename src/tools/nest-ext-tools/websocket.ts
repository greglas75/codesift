import {
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  maskNestSource,
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

      const classBody = source.slice(owner.bodyStart + 1, owner.end - 1);
      const maskedBody = maskNestSource(classBody);
      const subRe = /@SubscribeMessage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
      let sm: RegExpExecArray | null;
      while ((sm = subRe.exec(classBody)) !== null) {
        if (maskedBody[sm.index] !== "@") continue;
        entry.events.push({ event: sm[1]!, handler: sm[2]! });
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
