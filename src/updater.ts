/**
 * updater.ts — Version management and update checking
 *
 * Checks the GitHub repository for newer releases and notifies the user.
 * Caches results for 24 hours to avoid excessive API calls.
 *
 * Storage: ~/.dt-agent/update-check.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ─── Paths ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_PATH = resolve(__dirname, "..", "package.json");
const CACHE_DIR = resolve(homedir(), ".dt-agent");
const CACHE_PATH = resolve(CACHE_DIR, "update-check.json");

// ─── Configuration ──────────────────────────────────────

/** Only check for updates once every 24 hours */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Timeout for GitHub API requests (5 seconds) */
const API_TIMEOUT_MS = 5000;

// ─── Types ──────────────────────────────────────────────

interface UpdateCache {
  lastCheck: string;
  latestVersion: string | null;
  releaseUrl: string | null;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

// ─── Version Utilities ──────────────────────────────────

/** Read current version from package.json */
export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Extract "owner/repo" from the repository field in package.json */
function getGitHubRepo(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
    const repo = pkg.repository?.url || pkg.repository;
    if (typeof repo === "string") {
      const match = repo.match(/github\.com[/:]([\w.-]+\/[\w.-]+)/);
      return match ? match[1].replace(/\.git$/, "") : null;
    }
  } catch {
    // package.json missing or malformed
  }
  return null;
}

/** Compare two semver strings: returns true if `latest` is newer than `current` */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [lM = 0, lm = 0, lp = 0] = parse(latest);
  const [cM = 0, cm = 0, cp = 0] = parse(current);
  if (lM !== cM) return lM > cM;
  if (lm !== cm) return lm > cm;
  return lp > cp;
}

// ─── Update Checking ────────────────────────────────────

/**
 * Check for available updates. Uses a 24-hour cache to avoid frequent API calls.
 * Silently returns "no update" on any network or config error.
 *
 * @param force - Skip cache and check immediately
 */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const current = getCurrentVersion();
  const repo = getGitHubRepo();

  // No repository configured — cannot check
  if (!repo) {
    return {
      currentVersion: current,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
    };
  }

  // Use cached result if still fresh
  if (!force) {
    try {
      if (existsSync(CACHE_PATH)) {
        const cache: UpdateCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
        if (Date.now() - new Date(cache.lastCheck).getTime() < CHECK_INTERVAL_MS) {
          return {
            currentVersion: current,
            latestVersion: cache.latestVersion,
            updateAvailable: cache.latestVersion
              ? isNewer(cache.latestVersion, current)
              : false,
            releaseUrl: cache.releaseUrl,
          };
        }
      }
    } catch {
      // Cache corrupted — proceed to live check
    }
  }

  // Fetch latest release from GitHub
  let latestVersion: string | null = null;
  let releaseUrl: string | null = null;

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": "dt-agent", Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { tag_name?: string; html_url?: string };
      latestVersion = data.tag_name?.replace(/^v/, "") || null;
      releaseUrl = data.html_url || null;
    }
  } catch {
    // Network error — try tags API
  }

  // Fallback: try tags if releases returned nothing
  if (!latestVersion) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
        headers: { "User-Agent": "dt-agent" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (resp.ok) {
        const tags = (await resp.json()) as Array<{ name: string }>;
        latestVersion = tags[0]?.name?.replace(/^v/, "") || null;
        releaseUrl = `https://github.com/${repo}/releases`;
      }
    } catch {
      // GitHub unreachable — silently fail
    }
  }

  // Cache the result
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cache: UpdateCache = {
      lastCheck: new Date().toISOString(),
      latestVersion,
      releaseUrl,
    };
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Cache write failed — not critical
  }

  return {
    currentVersion: current,
    latestVersion,
    updateAvailable: latestVersion ? isNewer(latestVersion, current) : false,
    releaseUrl,
  };
}
