/**
 * `PinPad` — an Apple-passcode-style on-screen numeric keypad for PIN entry.
 *
 * The number pad is always up and ready (zero taps before typing — no system
 * keyboard pop-in, and the big 64pt keys work with gloves). Digits fill dot
 * indicators as they're typed; the pad auto-submits when the entry reaches
 * `maxLength`, and an explicit "Enter" key submits shorter PINs. A wrong PIN
 * is signalled by bumping `errorSignal` (parent increments it), which shakes
 * the dots and clears the entry so the operator can retype immediately.
 *
 * There is no TextInput here, so there is no system keyboard to dismiss; the
 * surrounding `KeyboardDismissible` wrapper (kept on PIN screens for parity
 * with the rest of the app) is a harmless no-op.
 */

import { useEffect, useRef } from "react";
import { Animated, Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export interface PinPadProps {
  /** The current PIN entry (controlled by the parent). */
  value: string;
  /** Update the entry (append / backspace / clear). */
  onChange: (next: string) => void;
  /** Maximum PIN length; auto-submit fires when the entry reaches this. */
  maxLength?: number;
  /** Minimum PIN length; the Enter key is enabled only once this is met. */
  minLength?: number;
  /** Increment to shake the dots and clear the entry (wrong-PIN feedback). */
  errorSignal?: number;
  /** Fired on auto-submit (length == maxLength) or when Enter is pressed. */
  onSubmit: (pin: string) => void;
  /** Disable all keys (e.g. during a lockout). */
  disabled?: boolean;
}

export function PinPad({
  value,
  onChange,
  maxLength = 8,
  minLength = 4,
  errorSignal = 0,
  onSubmit,
  disabled = false,
}: PinPadProps): React.ReactNode {
  const shake = useRef(new Animated.Value(0)).current;

  // On each errorSignal bump: clear the entry and run a short shake.
  useEffect(() => {
    if (errorSignal === 0) return;
    onChange("");
    Animated.sequence([
      Animated.timing(shake, { toValue: 10, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -10, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 6, duration: 45, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 45, useNativeDriver: true }),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorSignal]);

  const press = (d: string): void => {
    if (disabled || value.length >= maxLength) return;
    const next = value + d;
    onChange(next);
    if (next.length === maxLength) onSubmit(next);
  };

  const back = (): void => {
    if (disabled) return;
    onChange(value.slice(0, -1));
  };

  const enter = (): void => {
    if (disabled || value.length < minLength) return;
    onSubmit(value);
  };

  return (
    <Animated.View style={{ transform: [{ translateX: shake }] }} className="items-center gap-8">
      <View className="flex-row gap-3.5">
        {Array.from({ length: maxLength }).map((_, i) => (
          <View
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full",
              i < value.length ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </View>

      <View className="flex-row flex-wrap justify-center gap-2.5">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Pressable
            key={d}
            onPress={() => press(d)}
            disabled={disabled}
            className="h-16 w-[30%] items-center justify-center rounded-2xl bg-muted active:opacity-60"
          >
            <Text className="text-2xl font-semibold text-foreground">{d}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={back}
          disabled={disabled || value.length === 0}
          className="h-16 w-[30%] items-center justify-center rounded-2xl active:opacity-60"
        >
          <Text className="text-2xl text-muted-foreground">⌫</Text>
        </Pressable>
        <Pressable
          onPress={() => press("0")}
          disabled={disabled}
          className="h-16 w-[30%] items-center justify-center rounded-2xl bg-muted active:opacity-60"
        >
          <Text className="text-2xl font-semibold text-foreground">0</Text>
        </Pressable>
        <Pressable
          onPress={enter}
          disabled={disabled || value.length < minLength}
          className="h-16 w-[30%] items-center justify-center rounded-2xl bg-brand-info active:opacity-60"
        >
          <Text className="text-base font-semibold text-white">Enter</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
