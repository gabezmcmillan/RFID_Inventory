/**
 * Link-device scanner — opens the camera, scans the QR rendered by the web
 * app's `/link-device` page, and exchanges the one-time token for a long-lived
 * bearer credential stored in `expo-secure-store` (see `src/auth/`). On
 * success it pops back to Settings, which re-reads the stored identity.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

import {
  exchangeOneTimeToken,
  getServerUrl,
  registerDevice,
  unreachableServerMessage,
} from "../src/auth";

export default function LinkDeviceScreen(): React.ReactNode {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (permission && !permission.granted) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const onScanned = async ({ data }: { data: string }): Promise<void> => {
    if (scanned || busy) return;
    const token = data.trim();
    if (!token) return;
    setScanned(true);
    setBusy(true);
    setError(null);
    try {
      const serverUrl = await getServerUrl();
      const cred = await exchangeOneTimeToken(serverUrl, token);
      // Register the device with the server (allowlist + permanent EPC byte).
      await registerDevice(serverUrl, cred.token);
      // A fresh bearer is now stored — escape any prior reauth/blocked state
      // and prime the sync credential store so the next cycle syncs.
      const { resetSync } = await import("../src/sync/access");
      resetSync();
      router.back();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the actionable "cannot reach" guidance for any network-style
      // failure rather than a raw fetch/ExpoModulesCore exception string.
      setError(
        /network request failed|could not connect|expo|swift|fetch failed/i.test(msg)
          ? unreachableServerMessage(await getServerUrl())
          : msg,
      );
      // Allow re-scan of the same or a fresh QR after a failure.
      setScanned(false);
    } finally {
      setBusy(false);
    }
  };

  if (!permission) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6">
        <Text className="text-center text-destructive">Camera access is required to scan the link QR.</Text>
        <Button onPress={() => void requestPermission()}>
          <Text>Grant camera access</Text>
        </Button>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned ? undefined : onScanned}
      />
      <View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
        <View className="h-64 w-64 border-2 border-white/80 rounded-2xl" />
      </View>
      <View className="absolute bottom-0 left-0 right-0 items-center gap-2 p-6">
        {busy ? (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator />
            <Text className="text-white">Linking…</Text>
          </View>
        ) : null}
        {error ? <Text className="text-destructive text-center">{error}</Text> : null}
        <Button variant="secondary" onPress={() => router.back()}>
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}
