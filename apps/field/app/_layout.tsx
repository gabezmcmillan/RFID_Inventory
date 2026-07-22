/**
 * Root expo-router layout: mounts the on-device {@link DatabaseProvider} and
 * initializes the reader service (loads the persisted transport toggle), then
 * renders the tabbed shell. Screens under this layout can assume the database
 * is open (they gate on `useDbStatus().loading`).
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { DatabaseProvider, useDbStatus } from "../src/db/provider";
import { readerService } from "../src/reader/readerService";
import { useEffect } from "react";

/** Loads the persisted reader-transport toggle once, before any connect(). */
function useReaderInit(): void {
  useEffect(() => {
    void readerService.init();
  }, []);
}

/** Gates children on the database being open; shows a spinner otherwise. */
function Gate({ children }: { children: React.ReactNode }): React.ReactNode {
  const { loading, error } = useDbStatus();
  useReaderInit();
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Database error: {error.message}</Text>
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout(): React.ReactNode {
  return (
    <DatabaseProvider>
      <Gate>
        <Stack screenOptions={{ headerShown: true }}>
          <Stack.Screen name="index" options={{ title: "RFID Field" }} />
          <Stack.Screen name="check-in" options={{ title: "Check In" }} />
          <Stack.Screen name="check-out" options={{ title: "Check Out" }} />
          <Stack.Screen name="sweep" options={{ title: "Sweep & Count" }} />
          <Stack.Screen name="warehouse" options={{ title: "Warehouse" }} />
          <Stack.Screen name="warehouse-group" options={{ title: "Group" }} />
          <Stack.Screen name="finder" options={{ title: "Find a Tag" }} />
          <Stack.Screen name="events" options={{ title: "Event Log" }} />
          <Stack.Screen name="admin" options={{ title: "Admin" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="dev-tools" options={{ title: "Dev Tools" }} />
        </Stack>
      </Gate>
      <StatusBar style="auto" />
    </DatabaseProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: "red", padding: 16, textAlign: "center" },
});
