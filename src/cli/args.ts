// ---------------------------------------------------------------------------
// CLI argument parsing and output helpers
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export type Flags = Record<string, string | boolean>;

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Handle --key=value syntax
      if (key.includes("=")) {
        const eqIdx = key.indexOf("=");
        flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        // Boolean flags: no next value, or next value is also a flag
        if (next === undefined || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

export function getFlag(flags: Flags, name: string): string | undefined {
  const val = flags[name];
  if (val === undefined || typeof val === "boolean") return undefined;
  return val;
}

export function getBoolFlag(flags: Flags, name: string): boolean | undefined {
  const val = flags[name];
  if (val === undefined) return undefined;
  if (val === true || val === "true") return true;
  if (val === "false") return false;
  return true;
}

export function getNumFlag(flags: Flags, name: string): number | undefined {
  const raw = getFlag(flags, name);
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (isNaN(num)) {
    die(`Invalid number for --${name}: ${raw}`);
  }
  return num;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function output(data: unknown, flags: Flags): void {
  const compact = getBoolFlag(flags, "compact");
  const indent = compact ? undefined : 2;
  process.stdout.write(JSON.stringify(data, null, indent) + "\n");
}

export function die(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

export function requireArg(args: string[], index: number, name: string): string {
  const val = args[index];
  if (val === undefined) {
    die(`Missing required argument: <${name}>`);
  }
  return val;
}

export function requireFlag(flags: Flags, name: string): string {
  const val = getFlag(flags, name);
  if (!val) {
    die(`Missing required flag: --${name} <ref>`);
  }
  return val;
}

export function parseCommaSeparated(flags: Flags, name: string): string[] | undefined {
  const raw = getFlag(flags, name);
  return raw ? raw.split(",").map(p => p.trim()) : undefined;
}
