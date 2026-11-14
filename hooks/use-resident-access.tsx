import { useEffect } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

export function useResidentAccess() {
  const colors = useColors();
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const allowed = Boolean(me.data?.id && (me.data.role === "admin" || me.data.residentStatus === "approved"));
  useEffect(() => {
    if (me.isLoading || me.error || me.data === undefined) return;
    if (!me.data?.id) {
      Alert.alert("Entre para continuar", "Faça login ou crie seu cadastro para acessar esta função.");
      router.replace("/login");
    } else if (!allowed) {
      Alert.alert(me.data.residentStatus === "blocked" ? "Cadastro bloqueado" : "Aguardando aprovação", me.data.residentStatus === "blocked" ? "Procure a gestão do Conecta Barra para regularizar o acesso." : "A gestão precisa aprovar seu cadastro antes de liberar os serviços.");
      router.replace("/(tabs)");
    }
  }, [allowed, me.data, me.error, me.isLoading]);
  return { allowed, loading: me.isLoading, error: me.error, retry: me.refetch, colors };
}

export function ResidentAccessLoading() {
  const colors = useColors();
  return <View style={[styles.loading, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /><Text style={[styles.loadingText, { color: colors.muted }]}>Verificando acesso…</Text></View>;
}

const styles = StyleSheet.create({ loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }, loadingText: { fontSize: 13 } });
