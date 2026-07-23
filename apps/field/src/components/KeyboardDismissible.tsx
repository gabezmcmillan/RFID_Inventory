/**
 * Tap-anywhere-to-dismiss wrapper for non-scrolling screens and modal sheets.
 *
 * Wraps children in a flex-1 `Pressable` whose `onPress` calls
 * `Keyboard.dismiss()`. Interactive children (Buttons, Pressables, TextInputs)
 * claim their own taps, so the dismiss handler only fires for taps on empty
 * areas — it does not steal taps from controls or prevent focusing an input.
 *
 * Use this for screens NOT backed by a ScrollView/FlatList (which own their own
 * `keyboardShouldPersistTaps` / `keyboardDismissMode` handling): the PIN entry
 * card, the set-PIN screen, dev tools, and modal sheets. For ScrollView/
 * FlatList screens, set those two props directly on the scroller instead.
 */
import { Keyboard, Pressable, type ViewStyle } from "react-native";

export interface KeyboardDismissibleProps {
  children: React.ReactNode;
  className?: string;
  style?: ViewStyle;
}

export function KeyboardDismissible({ children, className, style }: KeyboardDismissibleProps): React.ReactNode {
  return (
    <Pressable className={className} style={style} onPress={() => Keyboard.dismiss()}>
      {children}
    </Pressable>
  );
}
