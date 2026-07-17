export interface AstroTemplateParse {
  islands: Island[];
  slots: Slot[];
  component_usages: ComponentUsage[];
  directives: Directive[];
  parse_confidence: "high" | "partial" | "degraded";
  scan_errors: string[];
}

export interface Island {
  component_name: string;
  directive: "client:load" | "client:idle" | "client:visible" | "client:media" | "client:only" | "server:defer";
  directive_value?: string | undefined;
  line: number;
  column: number;
  conditional: boolean;
  in_loop: boolean;
  uses_spread: boolean;
  resolves_to_file?: string | undefined;
  target_kind: "astro" | "framework" | "unknown";
  framework_hint?: "react" | "vue" | "svelte" | "solid" | "preact" | "lit" | undefined;
  document_order: number;
  parent_tag?: string | undefined;
  is_inside_section?: "header" | "footer" | "aside" | "nav" | "main" | null | undefined;
}

export interface Slot { name: string; line: number; has_fallback: boolean; }
export interface ComponentUsage { name: string; line: number; imported_from?: string | undefined; }
export interface Directive { name: string; value?: string | undefined; line: number; target_tag: string; }

export type SectionLandmark = "header" | "footer" | "aside" | "nav" | "main";
