/**
 * Sync status banner (plan 010, Phase 3) — a compact, always-visible strip that
 * surfaces the coordinator's status using the vendored field UI components
 * (`Badge`, `Text`, `Icon`). Maps each {@link SyncStatus} to a label + tone so
 * the operator can see at a glance whether the phone is synced, retrying,
 * offline with pending changes, or needs re-link/upgrade. Hidden on
 * `idle`/`synced` to stay out of the way once things are quiet.
 */

import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { CloudOff, RefreshCw, CloudUpload, CheckCircle2, AlertTriangle } from "lucide-react-native";
import { View } from "react-native";
import type { SyncStatus } from "./status";
import { statusLabel } from "./status";

interface Props {
  status: SyncStatus;
  lastSyncedAt: number | null;
}

/** Map a status to a Badge tone. */
function badgeVariant(status: SyncStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "syncing":
    case "retrying":
      return "secondary";
    case "pending":
      return "outline";
    case "reauth":
    case "blocked":
      return "destructive";
    case "idle":
    case "synced":
      return "default";
  }
}

/** Pick a glanceable icon for the active status. */
function statusIcon(status: SyncStatus): React.ReactNode {
  switch (status) {
    case "syncing":
    case "retrying":
      return <Icon as={RefreshCw} size={14} className="text-muted-foreground" />;
    case "pending":
      return <Icon as={CloudUpload} size={14} className="text-muted-foreground" />;
    case "reauth":
    case "blocked":
      return <Icon as={CloudOff} size={14} className="text-destructive" />;
    case "idle":
    case "synced":
      return <Icon as={CheckCircle2} size={14} className="text-status-in" />;
  }
}

function relativeTime(at: number | null, now: number): string | null {
  if (at === null) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function SyncStatusBanner({ status, lastSyncedAt }: Props): React.ReactNode {
  // Stay quiet once everything is settled.
  if (status === "idle" || status === "synced") {
    if (lastSyncedAt === null) return null;
    return (
      <View className="flex-row items-center justify-center gap-1.5 px-3 py-1">
        <Icon as={CheckCircle2} size={13} className="text-status-in" />
        <Text className="text-xs text-muted-foreground">
          Synced {relativeTime(lastSyncedAt, Date.now())}.
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center justify-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
      {statusIcon(status)}
      <Badge variant={badgeVariant(status)}>{statusLabel(status)}</Badge>
      {status === "reauth" || status === "blocked" ? (
        <View className="flex-row items-center gap-1">
          <Icon as={AlertTriangle} size={12} className="text-destructive" />
          <Text className="text-xs text-destructive">Re-link or update the app to resume.</Text>
        </View>
      ) : null}
    </View>
  );
}
