/**
 * Settings route — transport toggle (Simulated / Bluetooth sled, persisted via
 * `AsyncStorage`), a check-power slider (10–29 dBm) calling
 * `readerService.setCheckPower` (mirrors app.py:262-268), and the label-printer
 * settings: `printer_host` (empty = printing disabled, mirroring
 * `printer.enabled()`), a "Test printer" button running `printerStatus`, and
 * `cloud_base_url` (used for label QR URLs; empty = no QR).
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

import { readerService, USE_NATIVE_TRANSPORT_KEY } from "../src/reader/readerService";
import {
  CLOUD_BASE_URL_KEY,
  loadPrinterSettings,
  PRINTER_HOST_KEY,
  saveCloudBaseUrl,
  savePrinterHost,
} from "../src/printer/printerSettings";
import { printerStatus, PRINTER_PORT } from "../src/printer/printerClient";
import { MISTRAL_API_KEY_STORAGE, loadMistralApiKey, saveMistralApiKey } from "../src/bol/mistralKey";

const MIN_POWER = 10;
const MAX_POWER = 29;

export default function SettingsScreen(): React.ReactNode {
  const [useNative, setUseNative] = useState(false);
  const [power, setPower] = useState(20);
  const [busy, setBusy] = useState(false);
  const [printerHost, setPrinterHost] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [mistralKey, setMistralKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState<boolean | null>(null);

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
    <View className="flex-1 p-5 gap-4">
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

      {Platform.OS === "ios" ? (
        <Text className="text-xs text-muted-foreground mt-2">
          Toggle key: <Text className="font-mono">{USE_NATIVE_TRANSPORT_KEY}</Text>; printer key:{" "}
          <Text className="font-mono">{PRINTER_HOST_KEY}</Text>; cloud key:{" "}
          <Text className="font-mono">{CLOUD_BASE_URL_KEY}</Text>; Mistral key:{" "}
          <Text className="font-mono">{MISTRAL_API_KEY_STORAGE}</Text>
        </Text>
      ) : null}
    </View>
  );
}
