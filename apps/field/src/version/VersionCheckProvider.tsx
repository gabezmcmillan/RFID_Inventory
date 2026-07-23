/**
 * Version-check provider (plan 010, Phase 5): on launch + app-foreground, fetch
 * `GET /api/field/version` and compare the server's latest build number to
 * this device's installed build (`Application.nativeBuildVersion`). When the
 * installed build is older, surface a non-blocking banner linking to the
 * `/field/install` page; the banner is dismissible and never blocks the app.
 *
 * The check is fire-and-forget with a coarse per-foreground throttle (no
 * NetInfo dep — a failed fetch is the offline signal and just records a
 * non-blocking error, no banner). The pure compare/reducer logic lives in
 * `versionCheck.ts`; this provider only supplies the I/O and the foreground
 * trigger.
 */

import { useEffect, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus, Linking } from "react-native";

import {
  initialVersionCheckState,
  versionCheckReducer,
  type VersionCheckState,
} from "./versionCheck";
import { fetchLatestFieldVersion, getInstalledBuildNumber } from "./installBuild";
import { VersionUpdateBanner } from "./VersionUpdateBanner";

export interface VersionCheckContextValue {
  state: VersionCheckState;
  dismiss: () => void;
}

import { createContext, useContext } from "react";
const VersionCheckContext = createContext<VersionCheckContextValue | null>(null);

/** Access the live version-check state + dismiss. null before the provider mounts. */
export function useVersionCheck(): VersionCheckContextValue | null {
  return useContext(VersionCheckContext);
}

/** Minimum interval between automatic foreground re-checks (ms). */
const FOREGROUND_RECHECK_MS = 5 * 60 * 1000;

export function VersionCheckProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [state, dispatch] = useReducer(versionCheckReducer, initialVersionCheckState);
  const lastCheckAt = useRef<number>(0);
  const installedBuild = useRef<number | null>(null);

  async function runCheck(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - lastCheckAt.current < FOREGROUND_RECHECK_MS) return;
    lastCheckAt.current = now;
    dispatch({ type: "check-start" });
    try {
      const [latest, installed] = await Promise.all([
        fetchLatestFieldVersion(fetch),
        installedBuild.current ?? (await getInstalledBuildNumber()),
      ]);
      installedBuild.current = installed;
      if (!latest) {
        // No build deployed / service unavailable — nothing to show.
        dispatch({ type: "reset" });
        return;
      }
      dispatch({
        type: "check-success",
        installedBuildNumber: installed,
        latestBuildNumber: latest.buildNumber,
        installUrl: latest.installUrl,
      });
    } catch (e) {
      dispatch({ type: "check-error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  useEffect(() => {
    void runCheck(true);
    const onChange = (next: AppStateStatus) => {
      if (next === "active") void runCheck(false);
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);

  const value: VersionCheckContextValue = {
    state,
    dismiss: () => dispatch({ type: "dismiss" }),
  };

  return (
    <VersionCheckContext.Provider value={value}>
      <VersionUpdateBanner
        status={state.status}
        installUrl={state.installUrl}
        onDismiss={value.dismiss}
      />
      {children}
    </VersionCheckContext.Provider>
  );
}

/** Open the install page in the device's browser (external link). */
export async function openInstallPage(installUrl: string): Promise<void> {
  await Linking.openURL(installUrl);
}
