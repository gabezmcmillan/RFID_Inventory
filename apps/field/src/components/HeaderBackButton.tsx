/**
 * Flat, Liquid-Glass-free back button for the iOS native-stack header.
 *
 * On iOS 26 the system wraps native header items (including the back button)
 * in Liquid Glass capsules. To keep the header flat per the operator's brand
 * direction, `_layout.tsx` replaces the native back button with this custom
 * item rendered via `unstable_headerLeftItems` with `hidesSharedBackground:
 * true`, so iOS does not draw the glass capsule around it. Swipe-back
 * (interactive pop) is a screen-level gesture and is unaffected.
 *
 * On Android `unstable_headerLeftItems` is ignored, so the platform's default
 * back button is used there — this component is iOS-only in practice.
 */

import { ChevronLeft } from "lucide-react-native";
import { Pressable } from "react-native";
import { useNavigation } from "expo-router";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

export function HeaderBackButton(): React.ReactNode {
  const navigation = useNavigation();
  return (
    <Pressable
      onPress={() => navigation.goBack()}
      hitSlop={8}
      className="flex-row items-center active:opacity-60"
      accessibilityLabel="Back"
      accessibilityRole="button"
    >
      <Icon as={ChevronLeft} size={24} className="text-brand-navy" />
      <Text className="ml-0.5 text-base font-semibold text-brand-navy">Back</Text>
    </Pressable>
  );
}
