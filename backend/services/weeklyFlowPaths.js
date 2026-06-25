import path from "path";

export const DEFAULT_WEEKLY_FLOW_LIBRARY_DIR = "aurral-weekly-flow";

export function getWeeklyFlowLibraryDirName() {
  const configured = String(
    process.env.WEEKLY_FLOW_LIBRARY_DIR || DEFAULT_WEEKLY_FLOW_LIBRARY_DIR,
  ).trim();
  const normalized = configured.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("/") || normalized.includes("..")) {
    throw new Error(
      `Invalid WEEKLY_FLOW_LIBRARY_DIR: ${process.env.WEEKLY_FLOW_LIBRARY_DIR}`,
    );
  }
  return normalized;
}

export function getWeeklyFlowLibraryRoot(weeklyFlowRoot) {
  return path.join(weeklyFlowRoot, getWeeklyFlowLibraryDirName());
}

export function getNavidromeWeeklyFlowLibraryPath() {
  const navidromePath = String(
    process.env.NAVIDROME_WEEKLY_FLOW_LIBRARY_PATH || "",
  ).trim();
  if (navidromePath) {
    return navidromePath.replace(/\\/g, "/").replace(/\/+$/, "");
  }
  const base = process.env.DOWNLOAD_FOLDER || "/data/downloads/tmp";
  const basePath = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${basePath}/${getWeeklyFlowLibraryDirName()}`;
}
