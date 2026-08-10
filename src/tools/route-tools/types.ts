import type { MiddlewareTraceResult } from "../../utils/nextjs.js";
import type { CodeSymbol, RouteFramework } from "../../types.js";

export interface RouteHandler {
  symbol: CodeSymbol;
  file: string;
  method?: string;
  framework: RouteFramework;
  router?: "app" | "pages";
}

export interface DbCall {
  symbol_name: string;
  file: string;
  line: number;
  operation: string;
}

export interface RouteTraceResult {
  path: string;
  handlers: RouteHandler[];
  call_chain: Array<{ name: string; file: string; kind: string; depth: number }>;
  db_calls: DbCall[];
  middleware?: MiddlewareTraceResult;
  layout_chain?: string[];
  server_actions?: Array<{ name: string; file: string; called_from?: string | undefined }>;
}

export type RouteCallNode = RouteTraceResult["call_chain"][number];
