import { Pressable, StyleSheet, Text } from "react-native";
import { router } from "expo-router";

export function HeaderBackButton() {
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(tabs)");
  };

  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Voltar" onPress={goBack} hitSlop={8} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <Text style={styles.arrow}>‹</Text>
      <Text style={styles.label}>Voltar</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 7, borderRadius: 10 },
  arrow: { color: "#FFFFFF", fontSize: 29, lineHeight: 32, fontWeight: "400", marginTop: -2 },
  label: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  pressed: { opacity: 0.7 },
});
