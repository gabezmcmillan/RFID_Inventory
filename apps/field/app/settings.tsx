/**
 * Settings route — transport toggle (Simulated / Bluetooth sled, persisted via
 * `AsyncStorage`), a check-power slider (10–29 dBm) calling
 * `readerService.setCheckPower` (mirrors app.py:262-268), and the label-printer
 * settings: `printer_host` (empty = printing disabled, mirroring
 * `printer.enabled()`), a "Test printer" button running `printerStatus`, and
 * `cloud_base_url` (used for label QR URLs; empty = no QR).
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

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
    <View style={styles.container}>
      <View style={styles.row}>
        <View>
          <Text style={styles.label}>Native Bluetooth sled</Text>
          <Text style={styles.hint}>Off = simulated reader (dev)</Text>
        </View>
        <Switch value={useNative} onValueChange={(v) => void toggleTransport(v)} disabled={busy} />
      </View>
      {transportMsg !== null ? (
        <Text style={[styles.statusMsg, transportMsg === "Sled connected." ? styles.statusOk : styles.statusBad]}>
          {transportMsg}
        </Text>
      ) : null}

      <View style={styles.row}>
        <Text style={styles.label}>Check power</Text>
        <View style={styles.powerRow}>
          <Pressable style={styles.stepBtn} onPress={() => adjustPower(-1)}>
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.powerValue}>{power} dBm</Text>
          <Pressable style={styles.stepBtn} onPress={() => adjustPower(1)}>
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.sectionLabel}>Label printer (Zebra ZD621R)</Text>
      <Text style={styles.hint}>Host IP on the warehouse LAN (empty = printing disabled)</Text>
      <TextInput
        style={styles.input}
        value={printerHost}
        onChangeText={onPrinterHostChange}
        placeholder="e.g. 10.1.57.18"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numeric"
      />
      <Pressable style={[styles.testBtn, !printerHost.trim() && styles.testBtnDisabled]} disabled={!printerHost.trim() || testing} onPress={() => void testPrinter()}>
        {testing ? <ActivityIndicator /> : <Text style={styles.testBtnText}>Test printer</Text>}
      </Pressable>
      {statusMsg !== null ? (
        <Text style={[styles.statusMsg, statusOk ? styles.statusOk : styles.statusBad]}>{statusMsg}</Text>
      ) : null}

      <Text style={styles.sectionLabel}>Cloud base URL</Text>
      <Text style={styles.hint}>Base for label QR links (empty = no QR code)</Text>
      <TextInput
        style={styles.input}
        value={cloudBaseUrl}
        onChangeText={onCloudBaseUrlChange}
        placeholder="https://example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={styles.sectionLabel}>Mistral OCR API key</Text>
      <Text style={styles.hint}>Enables online BOL extraction (empty = local on-device OCR only)</Text>
      <TextInput
        style={styles.input}
        value={mistralKey}
        onChangeText={onMistralKeyChange}
        placeholder="sk-…"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        keyboardType="default"
      />

      {Platform.OS === "ios" ? (
        <Text style={styles.note}>
          Toggle key: <Text style={styles.mono}>{USE_NATIVE_TRANSPORT_KEY}</Text>; printer key:{" "}
          <Text style={styles.mono}>{PRINTER_HOST_KEY}</Text>; cloud key:{" "}
          <Text style={styles.mono}>{CLOUD_BASE_URL_KEY}</Text>; Mistral key:{" "}
          <Text style={styles.mono}>{MISTRAL_API_KEY_STORAGE}</Text>
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 16, fontWeight: "600" },
  hint: { fontSize: 12, color: "#888" },
  powerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  stepText: { fontSize: 22, fontWeight: "600" },
  powerValue: { fontSize: 16, fontWeight: "600", minWidth: 64, textAlign: "center" },
  sectionLabel: { fontSize: 14, fontWeight: "600", marginTop: 8, color: "#333" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 10, fontSize: 16, marginTop: 4 },
  testBtn: { backgroundColor: "#0a7", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 8 },
  testBtnDisabled: { backgroundColor: "#bbb" },
  testBtnText: { color: "white", fontSize: 16, fontWeight: "600" },
  statusMsg: { fontSize: 13, marginTop: 6 },
  statusOk: { color: "#0a7" },
  statusBad: { color: "#c33" },
  note: { fontSize: 12, color: "#888", marginTop: 8 },
  mono: { fontFamily: "monospace" },
});
