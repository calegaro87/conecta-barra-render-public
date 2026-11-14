import { Image, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { BRAND } from "@/constants/brand";
import { OFFICIAL_CONTACT } from "@/shared/official";

const appIcon = require("@/assets/images/icon.png");
// Substitua assets/brand/prefeitura-logo.png pelo logotipo oficial 2026 (mesmo nome de arquivo).
const prefeituraLogo = require("@/assets/brand/prefeitura-logo.png");

export function AppMark({ size = 64, radius }: { size?: number; radius?: number }) {
  return <Image source={appIcon} accessibilityLabel="Logotipo Conecta Barra" style={{ width: size, height: size, borderRadius: radius ?? size * 0.26 }} />;
}

/** Selo institucional: logotipo da Prefeitura + nome, para cabeçalhos e rodapés. */
export function PrefeituraBadge({ light = false, compact = false, style }: { light?: boolean; compact?: boolean; style?: ViewStyle }) {
  const color = light ? "#FFFFFF" : BRAND.navy;
  return (
    <View style={[styles.row, style]} accessibilityLabel={OFFICIAL_CONTACT.name}>
      <Image source={prefeituraLogo} resizeMode="contain" style={[styles.logo, compact && { width: 30, height: 30 }, light && styles.logoLight]} />
      <View>
        <Text style={[styles.small, { color, opacity: 0.8 }]}>Prefeitura Municipal de</Text>
        <Text style={[styles.big, { color }]}>Barra do Piraí</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 40, height: 40 },
  logoLight: { backgroundColor: "#FFFFFF", borderRadius: 10, padding: 2 },
  small: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3 },
  big: { fontSize: 15, fontWeight: "900", letterSpacing: -0.2 },
});
