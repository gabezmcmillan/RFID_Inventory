/**
 * Find a Tag screen (app.py:939-943, reader.py finder mode, config.py:61-74).
 * Entered from a warehouse box row with a target EPC: shows the target box
 * (via `findTag`), arms the reader in `finder` mode with that EPC, and renders
 * a big proximity bar driven by `{event:"finder", percent}`. Haptics pulse
 * faster as percent rises (interval lerped 600 ms → 80 ms over 0 → 100), and
 * `readerService.alert()` fires once per aim when percent first reaches ≥ 90.
 * `finder_reset` (trigger release) clears the bar and re-arms the alert.
 * Leaving the screen returns the reader to `idle`.
 */

import { findTag, type Tag } from "@rfid/domain";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useDb } from "../db/provider";
import { useReaderEvents } from "../hooks/useReaderEvents";
import { readerService } from "../reader/readerService";

/** Haptic pulse interval at 0% signal (ms). */
const PULSE_MS_MIN_SIGNAL = 600;
/** Haptic pulse interval at 100% signal (ms). */
const PULSE_MS_MAX_SIGNAL = 80;
/** Percent at/above which the one-shot handheld alert fires. */
const ALERT_THRESHOLD_PERCENT = 90;

/** Lerp the pulse interval over percent 0 → 100 (600 ms → 80 ms). */
function pulseIntervalMs(percent: number): number {
  const t = Math.max(0, Math.min(100, percent)) / 100;
  return Math.round(PULSE_MS_MIN_SIGNAL + (PULSE_MS_MAX_SIGNAL - PULSE_MS_MIN_SIGNAL) * t);
}

export function FinderScreen(): React.ReactNode {
  const db = useDb();
  const params = useLocalSearchParams<{ epc: string }>();
  const targetEpc = (params.epc ?? "").toUpperCase();

  const [tag, setTag] = useState<Tag | null>(null);
  const [percent, setPercent] = useState(0);

  // Latest percent in a ref so the haptic loop reads fresh values without
  // re-subscribing on every event (the loop self-schedules).
  const percentRef = useRef(0);
  // Whether the trigger is currently held (a finder stream is active).
  const trackingRef = useRef(false);
  // One-shot alert re-armed on each finder_reset; fires once per aim at ≥90%.
  const alertArmedRef = useRef(true);

  // Load the target box once.
  useEffect(() => {
    void (async () => {
      if (targetEpc) setTag(await findTag(db, targetEpc));
    })();
  }, [db, targetEpc]);

  // Arm `finder` on focus; return the reader to `idle` on blur (app.py:944-947).
  useEffect(() => {
    if (targetEpc) readerService.setMode("finder", { targetEpc });
    return () => {
      readerService.setMode("idle");
    };
  }, [targetEpc]);

  // Finder events: update the bar; fire the one-shot alert at ≥90%; track
  // holds for the haptic loop. finder_reset clears the bar and re-arms.
  useReaderEvents((event) => {
    if (event.event === "finder" && event.epc === targetEpc) {
      trackingRef.current = true;
      percentRef.current = event.percent;
      setPercent(event.percent);
      if (event.percent >= ALERT_THRESHOLD_PERCENT && alertArmedRef.current) {
        alertArmedRef.current = false;
        readerService.alert();
      }
    } else if (event.event === "finder_reset") {
      trackingRef.current = false;
      percentRef.current = 0;
      alertArmedRef.current = true;
      setPercent(0);
    }
  });

  // Haptic loop: while tracking, pulse on an interval that tightens with the
  // rising percent. Self-scheduled via setTimeout so each tick reads the
  // latest percent; stops when no longer tracking.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      if (!trackingRef.current) {
        timer = null;
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      timer = setTimeout(tick, pulseIntervalMs(percentRef.current));
    };
    // Start the loop when tracking begins; poll lightly until it does.
    const starter = setInterval(() => {
      if (trackingRef.current && timer === null) {
        tick();
      }
    }, 100);
    return () => {
      clearInterval(starter);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const simulate = (rssi: number): void => {
    // Dev-only: stream an RI for the target EPC through the simulated transport.
    const sim = readerService.simulated;
    if (!sim || !targetEpc) return;
    sim.simulateTriggerPull([targetEpc], { [targetEpc]: rssi });
  };

  const simulateRelease = (): void => {
    readerService.simulated?.simulateTriggerRelease();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Find a Tag</Text>
      {tag ? (
        <View>
          <Text style={styles.boxTitle}>{tag.item_type}{tag.item_name ? ` · ${tag.item_name}` : ""}</Text>
          <Text style={styles.meta}>Item No. {tag.sku || "—"}</Text>
          <Text style={styles.mono}>{tag.epc}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>{targetEpc ? "Target tag not registered." : "No target EPC."}</Text>
      )}

      <View style={styles.barOuter}>
        <View style={[styles.barFill, { height: `${percent}%` }]} />
        <View style={styles.barLabel}>
          <Text style={styles.percentText}>{percent}%</Text>
        </View>
      </View>

      {percent >= ALERT_THRESHOLD_PERCENT ? (
        <Text style={styles.locked}>● LOCKED</Text>
      ) : null}

      {__DEV__ ? (
        <View style={styles.devRow}>
          <Text style={styles.devLabel}>Dev (simulated transport):</Text>
          <View style={styles.devBtnRow}>
            <Pressable style={styles.devBtn} onPress={() => simulate(-75)}><Text style={styles.devBtnText}>25%</Text></Pressable>
            <Pressable style={styles.devBtn} onPress={() => simulate(-60)}><Text style={styles.devBtnText}>50%</Text></Pressable>
            <Pressable style={styles.devBtn} onPress={() => simulate(-45)}><Text style={styles.devBtnText}>88%</Text></Pressable>
            <Pressable style={styles.devBtn} onPress={() => simulate(-40)}><Text style={styles.devBtnText}>100%</Text></Pressable>
            <Pressable style={[styles.devBtn, styles.devBtnRelease]} onPress={simulateRelease}><Text style={styles.devBtnText}>release</Text></Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 24, fontWeight: "bold" },
  boxTitle: { fontSize: 18, fontWeight: "600" },
  meta: { fontSize: 13, color: "#666" },
  mono: { fontFamily: "monospace", fontSize: 12, color: "#444" },
  hint: { color: "#c33", fontStyle: "italic" },
  barOuter: { flex: 1, minHeight: 280, borderWidth: 1, borderColor: "#ccc", borderRadius: 12, backgroundColor: "#f2f2f2", justifyContent: "flex-end", overflow: "hidden", position: "relative" },
  barFill: { backgroundColor: "#0a7", width: "100%" },
  barLabel: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  percentText: { fontSize: 48, fontWeight: "bold", color: "#222" },
  locked: { color: "#0a7", fontWeight: "bold", fontSize: 18, textAlign: "center" },
  devRow: { marginTop: 8 },
  devLabel: { fontSize: 12, color: "#888", marginBottom: 4 },
  devBtnRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  devBtn: { backgroundColor: "#eee", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  devBtnRelease: { backgroundColor: "#c33" },
  devBtnText: { color: "#333", fontWeight: "600", fontSize: 13 },
});
