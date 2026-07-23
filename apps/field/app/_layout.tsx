/**
 * Root expo-router layout: mounts the on-device {@link DatabaseProvider} and
 * initializes the reader service (loads the persisted transport toggle), then
 * renders the tabbed shell. Screens under this layout can assume the database
 * is open (they gate on `useDbStatus().loading`).
 */

import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Text, View } from "react-native";
import { PortalHost } from "@rn-primitives/portal";

import { DatabaseProvider, useDbStatus } from "../src/db/provider";
import { SyncProvider } from "../src/sync/SyncProvider";
import { LockProvider } from "../src/auth/LockProvider";
import { VersionCheckProvider } from "../src/version/VersionCheckProvider";
import { readerService } from "../src/reader/readerService";
import { useEffect } from "react";

/**
 * Loads the persisted reader-transport toggle once and auto-connects the sled
 * when the native transport is selected (no-op for the simulated default).
 */
function useReaderInit(): void {
  useEffect(() => {
    void readerService.autoConnect();
  }, []);
}

/** Gates children on the database being open; shows a spinner otherwise. */
function Gate({ children }: { children: React.ReactNode }): React.ReactNode {
  const { loading, error } = useDbStatus();
  useReaderInit();
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (error) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="px-4 text-center text-destructive">
          Database error: {error.message}
        </Text>
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout(): React.ReactNode {
  return (
    <DatabaseProvider>
      <LockProvider>
        <Gate>
          <VersionCheckProvider>
            <SyncProvider>
            <Stack
              screenOptions={{
                headerShown: true,
                headerBackTitle: "Back",
                headerBackTitleStyle: { fontSize: 16 },
                headerTintColor: "hsl(var(--brand-navy))",
                headerTitleStyle: { fontWeight: "700" },
                contentStyle: { backgroundColor: "hsl(var(--background))" },
              }}
            >
              <Stack.Screen name="index" options={{ title: "RFID Field" }} />
              <Stack.Screen name="check-in" options={{ title: "Check In" }} />
              <Stack.Screen name="check-out" options={{ title: "Check Out" }} />
              <Stack.Screen name="sweep" options={{ title: "Sweep & Count" }} />
              <Stack.Screen name="warehouse" options={{ title: "Warehouse" }} />
              <Stack.Screen name="warehouse-group" options={{ title: "Group" }} />
              <Stack.Screen name="bol-docs" options={{ title: "BOL Documents" }} />
              <Stack.Screen name="finder" options={{ title: "Find a Tag" }} />
              <Stack.Screen name="events" options={{ title: "Event Log" }} />
              <Stack.Screen name="requests" options={{ title: "Requests" }} />
              <Stack.Screen name="admin" options={{ title: "Admin" }} />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="link-device" options={{ title: "Link Device" }} />
              <Stack.Screen name="set-pin" options={{ title: "Set Device PIN" }} />
              <Stack.Screen name="dev-tools" options={{ title: "Dev Tools" }} />
            </Stack>
            </SyncProvider>
          </VersionCheckProvider>
        </Gate>
      </LockProvider>
      <StatusBar style="auto" />
      {/* PortalHost must be the last child of the root providers; overlays
          (Dialog, DropdownMenu, etc.) render into it. */}
      <PortalHost />
    </DatabaseProvider>
  );
}
