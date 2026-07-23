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
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

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
    <View className="flex-1 gap-3 p-5">
      <Text className="text-2xl font-bold text-foreground">Find a Tag</Text>
      {tag ? (
        <View>
          <Text className="text-lg font-semibold text-foreground">{tag.item_type}{tag.item_name ? ` · ${tag.item_name}` : ""}</Text>
          <Text className="text-[13px] text-muted-foreground">Item No. {tag.sku || "—"}</Text>
          <Text className="font-mono text-xs text-muted-foreground">{tag.epc}</Text>
        </View>
      ) : (
        <Text className="text-sm italic text-destructive">{targetEpc ? "Target tag not registered." : "No target EPC."}</Text>
      )}

      <View className="relative min-h-70 flex-1 justify-end overflow-hidden rounded-xl border border-border bg-muted/40">
        <View style={[styles.barFill, { height: `${percent}%` }]} />
        <View className="absolute inset-0 items-center justify-center">
          <Text className="text-5xl font-bold text-foreground">{percent}%</Text>
        </View>
      </View>

      {percent >= ALERT_THRESHOLD_PERCENT ? (
        <Text className="text-center text-lg font-bold text-primary">● LOCKED</Text>
      ) : null}

      {__DEV__ ? (
        <View className="mt-2">
          <Text className="mb-1 text-xs text-muted-foreground">Dev (simulated transport):</Text>
          <View className="flex-row flex-wrap gap-2">
            <Pressable className="rounded-md bg-muted px-3 py-2" onPress={() => simulate(-75)}><Text className="text-[13px] font-semibold text-foreground">25%</Text></Pressable>
            <Pressable className="rounded-md bg-muted px-3 py-2" onPress={() => simulate(-60)}><Text className="text-[13px] font-semibold text-foreground">50%</Text></Pressable>
            <Pressable className="rounded-md bg-muted px-3 py-2" onPress={() => simulate(-45)}><Text className="text-[13px] font-semibold text-foreground">88%</Text></Pressable>
            <Pressable className="rounded-md bg-muted px-3 py-2" onPress={() => simulate(-40)}><Text className="text-[13px] font-semibold text-foreground">100%</Text></Pressable>
            <Button variant="destructive" size="sm" onPress={simulateRelease}><Text>release</Text></Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// The proximity bar fill height is a computed numeric style (percent of signal);
// keep it as a StyleSheet entry rather than recomputing a className each event.
const styles = StyleSheet.create({
  barFill: { backgroundColor: "#0a7", width: "100%" },
});
