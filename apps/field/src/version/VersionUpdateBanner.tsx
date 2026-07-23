/**
 * Version-update banner (plan 010, Phase 5) — a non-blocking strip shown only
 * when the installed field build is older than the latest build the server
 * knows about. Links to the `/field/install` page (opened in the device
 * browser via `Linking`). Dismissible; never blocks the app. Hidden for every
 * other status (idle/checking/current/error) to stay out of the way.
 */

import { Linking, Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import type { VersionCheckStatus } from "./versionCheck";

interface Props {
  status: VersionCheckStatus;
  installUrl: string | null;
  onDismiss: () => void;
}

export function VersionUpdateBanner({
  status,
  installUrl,
  onDismiss,
}: Props): React.ReactNode {
  if (status !== "stale" || !installUrl) return null;
  return (
    <View className="flex-row items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2">
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Open the install page in the browser"
        onPress={() => {
          void Linking.openURL(installUrl);
        }}
      >
        <Text className="text-xs text-foreground">
          A newer RFID Field build is available.{" "}
          <Text className="text-xs font-semibold underline">Install update</Text>
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss update banner" onPress={onDismiss}>
        <Text className="text-xs text-muted-foreground">Dismiss</Text>
      </Pressable>
    </View>
  );
}
