import { Tabs } from "expo-router";
import { FloatingTabBar } from "@/components/floating-tab-bar";
import { trpc } from "@/lib/trpc";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const meQuery = trpc.auth.me.useQuery(undefined, { retry: 2, retryDelay: (attempt) => Math.min(1500 * 2 ** attempt, 5000), staleTime: 5_000 });
  const notificationQuery = trpc.notifications.list.useQuery(undefined, { enabled: Boolean(meQuery.data?.id), retry: false, staleTime: 2_000, refetchInterval: 45_000, refetchIntervalInBackground: false });
  const unread = (notificationQuery.data ?? []).filter((item) => !item.readAt).length;

  return (
    <Tabs
      screenOptions={{ animation: "fade", headerShown: false, sceneStyle: { paddingBottom: 78 + Math.max(insets.bottom, 10) } }}
      tabBar={(props) => <FloatingTabBar {...props} badges={{ notifications: unread }} />}
    >
      <Tabs.Screen name="index" options={{ title: "Início" }} />
      <Tabs.Screen name="requests" options={{ title: "Pedidos" }} />
      <Tabs.Screen name="portal" options={{ title: "Portal local" }} />
      <Tabs.Screen name="notifications" options={{ title: "Avisos" }} />
      <Tabs.Screen name="profile" options={{ title: "Conta" }} />
      <Tabs.Screen name="configuration" options={{ href: null }} />
    </Tabs>
  );
}
