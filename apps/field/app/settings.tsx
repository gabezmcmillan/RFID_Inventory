/**
 * Settings route — transport toggle (Simulated / Bluetooth sled, persisted via
 * `AsyncStorage`), a check-power slider (10–29 dBm) calling
 * `readerService.setCheckPower` (mirrors app.py:262-268), the label-printer
 * settings: `printer_host` (empty = printing disabled, mirroring
 * `printer.enabled()`), a "Test printer" button running `printerStatus`, and
 * `cloud_base_url` (used for label QR URLs; empty = no QR).
 *
 * Device linking (plan: mobile auth): the web app base URL the phone exchanges
 * the one-time code against (dev default `http://localhost:3000` — set to the
 * Mac's LAN IP for a physical device), a "Link device" button that opens the
 * QR scanner, the linked identity (name/email) when a device is linked, and an
 * "Unlink" action that clears the stored bearer credential.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

import { readerService, USE_NATIVE_TRANSPORT_KEY } from "../src/reader/readerService";
import { fieldEnv } from "../src/config/env";
import {
  CLOUD_BASE_URL_KEY,
  loadPrinterSettings,
  PRINTER_HOST_KEY,
  saveCloudBaseUrl,
  savePrinterHost,
} from "../src/printer/printerSettings";
import { printerStatus, PRINTER_PORT } from "../src/printer/printerClient";
import { MISTRAL_API_KEY_STORAGE, loadMistralApiKey, saveMistralApiKey } from "../src/bol/mistralKey";
import { useLock } from "../src/auth/LockProvider";
import {
  clearLinkedCredential,
  DEFAULT_SERVER_URL,
  getLinkedIdentity,
  getLinkedToken,
  getServerUrl,
  type LinkedIdentity,
  SERVER_URL_KEY,
  setServerUrl,
  testServerConnection,
  trySetServerUrl,
  unlinkDevice,
  validateServerUrl,
} from "../src/auth";

const MIN_POWER = 10;
const MAX_POWER = 29;

export default function SettingsScreen(): React.ReactNode {
  const router = useRouter();
  const lock = useLock();
  const [useNative, setUseNative] = useState(false);
  const [power, setPower] = useState(20);
  const [busy, setBusy] = useState(false);
  const [printerHost, setPrinterHost] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [mistralKey, setMistralKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState<boolean | null>(null);
  const [serverUrl, setServerUrlState] = useState("");
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [serverUrlIsPrivate, setServerUrlIsPrivate] = useState<boolean | null>(null);
  const [testingServer, setTestingServer] = useState(false);
  const [serverTestMsg, setServerTestMsg] = useState<string | null>(null);
  const [serverTestOk, setServerTestOk] = useState<boolean | null>(null);
  const [linked, setLinked] = useState<LinkedIdentity | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  useEffect(() => {
    void readerService.init().then(() => setUseNative(readerService.useNativeTransport));
  }, []);

  useEffect(() => {
    void loadPrinterSettings().then((s) => {
      setPrinterHost(s.printerHost);
      setCloudBaseUrl(s.cloudBaseUrl);
    });
  }, []);

  useEffect(() => {
    void loadMistralApiKey().then(setMistralKey);
  }, []);

  useEffect(() => {
    void getServerUrl().then((stored) => {
      setServerUrlState(stored);
      const v = validateServerUrl(stored);
      setServerUrlError(v.error ?? null);
      setServerUrlIsPrivate(v.isPrivate ?? null);
    });
  }, []);

  // Re-read the linked identity whenever Settings regains focus (e.g. after
  // the QR scanner pops back with a freshly stored credential).
  useFocusEffect(() => {
    void getLinkedIdentity().then(setLinked);
  });

  const [transportMsg, setTransportMsg] = useState<string | null>(null);

  const toggleTransport = async (value: boolean): Promise<void> => {
    setBusy(true);
    setTransportMsg(null);
    try {
      await readerService.setUseNativeTransport(value);
      setUseNative(value);
      if (value) setTransportMsg("Sled connected.");
    } catch (err) {
      // Choice persists; the sled may be off/unpaired. Surface why.
      setUseNative(value);
      setTransportMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const adjustPower = (delta: number): void => {
    const next = Math.min(MAX_POWER, Math.max(MIN_POWER, power + delta));
    setPower(next);
    readerService.setCheckPower(next);
  };

  const onPrinterHostChange = (value: string): void => {
    setPrinterHost(value);
    void savePrinterHost(value);
  };

  const onCloudBaseUrlChange = (value: string): void => {
    setCloudBaseUrl(value);
    void saveCloudBaseUrl(value);
  };

  const onMistralKeyChange = (value: string): void => {
    setMistralKey(value);
    void saveMistralApiKey(value);
  };

  const onServerUrlChange = (value: string): void => {
    setServerUrlState(value);
    setServerTestMsg(null);
    setServerTestOk(null);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      // Empty clears the override; the default is used on next load. Don't
      // flag an error here — the placeholder shows the default in use.
      setServerUrlError(null);
      setServerUrlIsPrivate(null);
      void setServerUrl("");
      return;
    }
    const v = validateServerUrl(value);
    setServerUrlError(v.error ?? null);
    setServerUrlIsPrivate(v.isPrivate ?? null);
    // Persist only valid, normalized URLs.
    if (v.ok && v.normalized) {
      void trySetServerUrl(value);
    }
  };

  const testServer = async (): Promise<void> => {
    setTestingServer(true);
    setServerTestMsg(null);
    setServerTestOk(null);
    try {
      const result = await testServerConnection(serverUrl);
      setServerTestOk(result.ok);
      setServerTestMsg(result.message);
    } finally {
      setTestingServer(false);
    }
  };

  const unlink = async (): Promise<void> => {
    setUnlinking(true);
    try {
      // Tell the server to revoke the device + session, then clear local state.
      const url = await getServerUrl();
      const token = await getLinkedToken();
      if (token) {
        await unlinkDevice(url, token);
      } else {
        await clearLinkedCredential();
      }
      // Drop any cached sync token so the coordinator goes reauth rather than
      // retrying a now-revoked credential.
      const { clearSyncCredential } = await import("../src/sync/access");
      clearSyncCredential();
      // Disarm the device-unlock gate so an unlinked device is not stuck locked
      // behind a PIN with no way to re-link.
      await lock?.clearDevicePin();
      setLinked(null);
    } finally {
      setUnlinking(false);
    }
  };

  const testPrinter = async (): Promise<void> => {
    if (!printerHost.trim()) return;
    setTesting(true);
    setStatusMsg(null);
    setStatusOk(null);
    try {
      const result = await printerStatus(printerHost.trim(), PRINTER_PORT);
      setStatusOk(result.ok);
      setStatusMsg(result.message);
    } catch (err) {
      setStatusOk(false);
      setStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-base font-semibold">Native Bluetooth sled</Text>
          <Text className="text-xs text-muted-foreground">Off = simulated reader (dev)</Text>
        </View>
        <Switch checked={useNative} onCheckedChange={(v) => void toggleTransport(v)} disabled={busy} />
      </View>
      {transportMsg !== null ? (
        <Text className={transportMsg === "Sled connected." ? "text-primary text-sm mt-1.5" : "text-destructive text-sm mt-1.5"}>
          {transportMsg}
        </Text>
      ) : null}

      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold">Check power</Text>
        <View className="flex-row items-center gap-3">
          <Button size="icon" variant="secondary" onPress={() => adjustPower(-1)}>
            <Text>−</Text>
          </Button>
          <Text className="text-base font-semibold min-w-16 text-center">{power} dBm</Text>
          <Button size="icon" variant="secondary" onPress={() => adjustPower(1)}>
            <Text>+</Text>
          </Button>
        </View>
      </View>

      <Text className="text-sm font-semibold mt-2 text-foreground">Label printer (Zebra ZD621R)</Text>
      <Text className="text-xs text-muted-foreground">Host IP on the warehouse LAN (empty = printing disabled)</Text>
      <Input
        value={printerHost}
        onChangeText={onPrinterHostChange}
        placeholder="e.g. 10.1.57.18"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numeric"
      />
      <Button
        className={!printerHost.trim() ? "opacity-50" : ""}
        disabled={!printerHost.trim() || testing}
        onPress={() => void testPrinter()}
      >
        {testing ? <ActivityIndicator /> : <Text>Test printer</Text>}
      </Button>
      {statusMsg !== null ? (
        <Text className={statusOk ? "text-primary text-sm mt-1.5" : "text-destructive text-sm mt-1.5"}>{statusMsg}</Text>
      ) : null}

      <Text className="text-sm font-semibold mt-2 text-foreground">Cloud base URL</Text>
      <Text className="text-xs text-muted-foreground">Base for label QR links (empty = no QR code)</Text>
      <Input
        value={cloudBaseUrl}
        onChangeText={onCloudBaseUrlChange}
        placeholder="https://example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text className="text-sm font-semibold mt-2 text-foreground">Mistral OCR API key</Text>
      <Text className="text-xs text-muted-foreground">Enables online BOL extraction (empty = local on-device OCR only)</Text>
      <Input
        value={mistralKey}
        onChangeText={onMistralKeyChange}
        placeholder="sk-…"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        keyboardType="default"
      />

      <View className="mt-2 border-t border-border pt-4 gap-2">
        <Text className="text-sm font-semibold text-foreground">Web server URL</Text>
        {fieldEnv.isProductionBuild ? (
          <View className="gap-1">
            <Text className="text-xs text-muted-foreground">
              Locked to the production server (<Text className="font-mono">{DEFAULT_SERVER_URL}</Text>) for this
              build. Dev-only LAN/Tailscale editing is unavailable in production.
            </Text>
          </View>
        ) : (
          <>
            <Text className="text-xs text-muted-foreground">
              Base the phone exchanges the link code against. On a physical iPhone this cannot be{" "}
              <Text className="font-mono">localhost</Text> (that is the phone itself) — set it to your
              Mac's LAN IP on the same Wi-Fi, e.g.{" "}
              <Text className="font-mono">http://10.1.81.56:3001</Text>. Production must use HTTPS.
            </Text>
            <Input
              value={serverUrl}
              onChangeText={onServerUrlChange}
              placeholder={DEFAULT_SERVER_URL}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {serverUrlError !== null ? (
              <Text className="text-destructive text-xs">{serverUrlError}</Text>
            ) : serverUrlIsPrivate === true ? (
              <Text className="text-xs text-muted-foreground">
                Local/private host — plain HTTP is fine for development.
              </Text>
            ) : null}
            <Button
              disabled={serverUrlError !== null || serverUrl.trim().length === 0 || testingServer}
              onPress={() => void testServer()}
            >
              {testingServer ? <ActivityIndicator /> : <Text>Test connection</Text>}
            </Button>
            {serverTestMsg !== null ? (
              <Text className={serverTestOk ? "text-primary text-sm mt-1.5" : "text-destructive text-sm mt-1.5"}>
                {serverTestMsg}
              </Text>
            ) : null}
          </>
        )}

        <Text className="text-sm font-semibold mt-2 text-foreground">Device account</Text>
        {linked ? (
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-base font-semibold">{linked.name}</Text>
                <Text className="text-xs text-muted-foreground">{linked.email}</Text>
              </View>
              <Button variant="secondary" disabled={unlinking} onPress={() => void unlink()}>
                {unlinking ? <ActivityIndicator /> : <Text>Unlink</Text>}
              </Button>
            </View>
          </View>
        ) : (
          <Button onPress={() => router.push("/link-device")}>
            <Text>Link device</Text>
          </Button>
        )}
      </View>

      {linked ? <ChangeDevicePinSection /> : null}

      {Platform.OS === "ios" ? (
        <Text className="text-xs text-muted-foreground mt-2">
          Toggle key: <Text className="font-mono">{USE_NATIVE_TRANSPORT_KEY}</Text>; printer key:{" "}
          <Text className="font-mono">{PRINTER_HOST_KEY}</Text>; cloud key:{" "}
          <Text className="font-mono">{CLOUD_BASE_URL_KEY}</Text>; Mistral key:{" "}
          <Text className="font-mono">{MISTRAL_API_KEY_STORAGE}</Text>; server key:{" "}
          <Text className="font-mono">{SERVER_URL_KEY}</Text>
        </Text>
      ) : null}
    </ScrollView>
  );
}

/** Change the device-unlock PIN (the app is already unlocked, so the operator can rotate it). */
function ChangeDevicePinSection(): React.ReactNode {
  const lock = useLock();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setMsg(null);
    if (pin.length < 4) {
      setMsg("PIN must be at least 4 digits.");
      return;
    }
    if (pin !== confirm) {
      setMsg("PINs do not match.");
      return;
    }
    setBusy(true);
    try {
      await lock?.setDevicePin(pin);
      setPin("");
      setConfirm("");
      setMsg("Device PIN updated.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not update PIN.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mt-3 gap-2">
      <Text className="text-sm font-semibold text-foreground">Device unlock PIN</Text>
      <Text className="text-xs text-muted-foreground">
        The PIN the warehouse operator enters to unlock this device.
      </Text>
      <Input
        value={pin}
        onChangeText={setPin}
        placeholder="New PIN (4–8 digits)"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Input
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Confirm new PIN"
        secureTextEntry
        keyboardType="number-pad"
      />
      <Button disabled={busy} onPress={() => void run()}>
        {busy ? <ActivityIndicator /> : <Text>Update device PIN</Text>}
      </Button>
      {msg ? <Text className="text-sm text-primary mt-1">{msg}</Text> : null}
    </View>
  );
}
