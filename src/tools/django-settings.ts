/**
 * analyze_django_settings — Django settings.py security and config audit.
 *
 * Scans Django settings modules for 15 known anti-patterns spanning security,
 * configuration, and deployment readiness. Uses the symbol index to locate
 * settings files (typically settings.py or settings/<env>.py).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

export interface SettingsFinding {
  rule: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  file: string;
  line: number;
  match: string;
  fix: string;
}

export interface DjangoSettingsResult {
  files_scanned: string[];
  findings: SettingsFinding[];
  total: number;
  by_severity: Record<string, number>;
}

/** Each check scans settings source for a pattern and emits findings. */
interface SettingsCheck {
  rule: string;
  severity: SettingsFinding["severity"];
  message: string;
  fix: string;
  detect: (source: string, lines: string[]) => Array<{ line: number; match: string }>;
}

const CHECKS: SettingsCheck[] = [
  {
    rule: "debug-enabled",
    severity: "critical",
    message: "DEBUG = True exposes stack traces and sensitive data in production",
    fix: "Set DEBUG = False in production. Use environment variable: DEBUG = os.environ.get('DEBUG', '').lower() == 'true'",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/^\s*DEBUG\s*=\s*True\b/.test(l)) hits.push({ line: i + 1, match: l.trim() });
      });
      return hits;
    },
  },
  {
    rule: "empty-allowed-hosts",
    severity: "critical",
    message: "ALLOWED_HOSTS = [] or missing — Django refuses to start in production",
    fix: "Set ALLOWED_HOSTS = ['yourdomain.com', 'www.yourdomain.com'] or use env var",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/^\s*ALLOWED_HOSTS\s*=\s*\[\s*\]/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "hardcoded-secret-key",
    severity: "critical",
    message: "SECRET_KEY is hardcoded — should come from environment variable",
    fix: "SECRET_KEY = os.environ['DJANGO_SECRET_KEY']",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        // Match SECRET_KEY = "literal-string" but not os.environ[...] or get_random_secret_key()
        if (/^\s*SECRET_KEY\s*=\s*["'][^"']+["']/.test(l) && !l.includes("environ") && !l.includes("getenv")) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "weak-secret-key",
    severity: "high",
    message: "SECRET_KEY contains known weak value (default/insecure/changeme)",
    fix: "Generate a new key: python -c 'from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())'",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      const weak = /SECRET_KEY\s*=\s*["'].*(django-insecure|changeme|secret|default|todo|xxx)/i;
      lines.forEach((l, i) => {
        if (weak.test(l)) hits.push({ line: i + 1, match: l.trim() });
      });
      return hits;
    },
  },
  {
    rule: "missing-csrf-middleware",
    severity: "high",
    message: "CsrfViewMiddleware not in MIDDLEWARE — CSRF protection disabled",
    fix: "Add 'django.middleware.csrf.CsrfViewMiddleware' to MIDDLEWARE",
    detect: (source) => {
      const mwMatch = source.match(/MIDDLEWARE\s*=\s*\[([\s\S]*?)\]/);
      if (!mwMatch) return [];
      if (!mwMatch[1]!.includes("CsrfViewMiddleware")) {
        return [{ line: 1, match: "MIDDLEWARE without CsrfViewMiddleware" }];
      }
      return [];
    },
  },
  {
    rule: "missing-security-middleware",
    severity: "high",
    message: "SecurityMiddleware not in MIDDLEWARE — missing HTTPS/HSTS/XFO headers",
    fix: "Add 'django.middleware.security.SecurityMiddleware' as first entry in MIDDLEWARE",
    detect: (source) => {
      const mwMatch = source.match(/MIDDLEWARE\s*=\s*\[([\s\S]*?)\]/);
      if (!mwMatch) return [];
      if (!mwMatch[1]!.includes("SecurityMiddleware")) {
        return [{ line: 1, match: "MIDDLEWARE without SecurityMiddleware" }];
      }
      return [];
    },
  },
  {
    rule: "insecure-cookie",
    severity: "high",
    message: "SESSION_COOKIE_SECURE or CSRF_COOKIE_SECURE not set to True — cookies sent over HTTP",
    fix: "SESSION_COOKIE_SECURE = True; CSRF_COOKIE_SECURE = True (for HTTPS deployments)",
    detect: (source) => {
      const hits: Array<{ line: number; match: string }> = [];
      if (!/SESSION_COOKIE_SECURE\s*=\s*True/.test(source)) {
        hits.push({ line: 1, match: "SESSION_COOKIE_SECURE not set to True" });
      }
      if (!/CSRF_COOKIE_SECURE\s*=\s*True/.test(source)) {
        hits.push({ line: 1, match: "CSRF_COOKIE_SECURE not set to True" });
      }
      return hits;
    },
  },
  {
    rule: "missing-hsts",
    severity: "medium",
    message: "SECURE_HSTS_SECONDS not set — HSTS header missing",
    fix: "SECURE_HSTS_SECONDS = 31536000  # 1 year",
    detect: (source) => {
      if (!/SECURE_HSTS_SECONDS\s*=/.test(source)) {
        return [{ line: 1, match: "SECURE_HSTS_SECONDS missing" }];
      }
      return [];
    },
  },
  {
    rule: "xframe-missing",
    severity: "medium",
    message: "X_FRAME_OPTIONS not set — vulnerable to clickjacking",
    fix: "X_FRAME_OPTIONS = 'DENY' (or 'SAMEORIGIN' if iframes within your site)",
    detect: (source) => {
      if (!/X_FRAME_OPTIONS\s*=/.test(source)) {
        return [{ line: 1, match: "X_FRAME_OPTIONS missing" }];
      }
      return [];
    },
  },
  {
    rule: "sqlite-in-prod",
    severity: "medium",
    message: "DATABASES uses SQLite — not suitable for production with multiple workers",
    fix: "Use PostgreSQL or MySQL for production. sqlite3 is fine for dev/testing only.",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/ENGINE.*django\.db\.backends\.sqlite3/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "default-db-password",
    severity: "critical",
    message: "Database password is hardcoded literal",
    fix: "Use os.environ['DB_PASSWORD'] instead of a string literal",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/['"]PASSWORD['"]\s*:\s*["'][^"']{1,100}["']/.test(l)
          && !l.includes("environ")
          && !l.includes("getenv")) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "wildcard-allowed-hosts",
    severity: "high",
    message: "ALLOWED_HOSTS = ['*'] accepts any Host header — Host header injection risk",
    fix: "Specify actual hostnames: ALLOWED_HOSTS = ['example.com', 'www.example.com']",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/ALLOWED_HOSTS\s*=\s*\[\s*['"]\*['"]\s*\]/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "cors-wildcard",
    severity: "high",
    message: "CORS_ALLOW_ALL_ORIGINS = True — allows any origin to make requests",
    fix: "Set CORS_ALLOWED_ORIGINS = ['https://yourdomain.com'] explicitly",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/CORS_ALLOW_ALL_ORIGINS\s*=\s*True/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "email-backend-console",
    severity: "low",
    message: "EMAIL_BACKEND is console — emails printed to stdout, not sent",
    fix: "In production: EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend' and configure SMTP settings",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/EMAIL_BACKEND\s*=\s*['"]django\.core\.mail\.backends\.console/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
  {
    rule: "logging-disabled",
    severity: "medium",
    message: "LOGGING_CONFIG = None disables Django's logging configuration",
    fix: "Remove the LOGGING_CONFIG = None override or configure logging manually",
    detect: (_source, lines) => {
      const hits: Array<{ line: number; match: string }> = [];
      lines.forEach((l, i) => {
        if (/^\s*LOGGING_CONFIG\s*=\s*None/.test(l)) {
          hits.push({ line: i + 1, match: l.trim() });
        }
      });
      return hits;
    },
  },
];

/**
 * Analyze Django settings files for security and configuration anti-patterns.
 */
export async function analyzeDjangoSettings(
  repo: string,
  options?: {
    settings_file?: string; // explicit file instead of auto-detection
  },
): Promise<DjangoSettingsResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Locate settings files
  let settingsFiles: string[];
  if (options?.settings_file) {
    settingsFiles = [options.settings_file];
  } else {
    settingsFiles = index.files
      .filter((f) => {
        if (!f.path.endsWith(".py")) return false;
        // Common patterns: settings.py, settings/*.py, config/settings.py, my_app/settings/base.py
        return /\/settings\.py$|\/settings\/[\w_]+\.py$/.test(f.path);
      })
      .map((f) => f.path);
  }

  if (settingsFiles.length === 0) {
    return {
      files_scanned: [],
      findings: [],
      total: 0,
      by_severity: {},
    };
  }

  const findings: SettingsFinding[] = [];

  for (const filePath of settingsFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, filePath), "utf-8");
    } catch {
      continue;
    }
    const lines = source.split("\n");

    for (const check of CHECKS) {
      const hits = check.detect(source, lines);
      for (const hit of hits) {
        findings.push({
          rule: check.rule,
          severity: check.severity,
          message: check.message,
          file: filePath,
          line: hit.line,
          match: hit.match,
          fix: check.fix,
        });
      }
    }
  }

  const by_severity: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
  }

  return {
    files_scanned: settingsFiles,
    findings,
    total: findings.length,
    by_severity,
  };
}
