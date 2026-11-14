import { AppState, type AppStateStatus } from "react-native";
import * as Network from "expo-network";
import { getWsUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";

export type RealtimeScope = "requests" | "announcements" | "notifications" | "suggestions" | "residents" | "dashboard" | "neighborhoods" | "social" | "me";
export type RealtimeStatus = "offline" | "connecting" | "live";

type ScopeListener = (scopes: RealtimeScope[]) => void;

/**
 * Cliente WebSocket com reconexão automática (backoff exponencial), reconexão imediata ao trocar de
 * rede (Wi-Fi ↔ 4G/5G) e ao voltar para o app. O servidor só envia "o que mudou"; o app recarrega
 * apenas as consultas afetadas. Funciona entre aparelhos e redes diferentes porque tudo passa pelo
 * servidor público (wss://).
 */
class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: RealtimeStatus = "offline";
  private statusListeners = new Set<(s: RealtimeStatus) => void>();
  private scopeListeners = new Set<ScopeListener>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private appStateSub: { remove: () => void } | null = null;
  private netSub: { remove: () => void } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastNetworkKey = "";
  private connecting = false;

  getStatus() { return this.status; }
  onStatus(listener: (s: RealtimeStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  onScopes(listener: ScopeListener) { this.scopeListeners.add(listener); return () => { this.scopeListeners.delete(listener); }; }

  private setStatus(next: RealtimeStatus) {
    if (this.status === next) return;
    this.status = next;
    this.statusListeners.forEach((l) => l(next));
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state !== "active") return;
      this.attempt = 0;
      // Ao voltar do segundo plano o Android/iOS pode ter matado o socket sem avisar: se estiver quieto há
      // mais de 35 s (o servidor manda batimento a cada 25 s), descarta e reconecta; senão apenas confere.
      if (this.ws && Date.now() - this.lastMessageAt > 35_000) this.dropSocket();
      void this.connect();
    });
    try {
      this.netSub = Network.addNetworkStateListener((state) => {
        const reachable = Boolean(state.isConnected) && state.isInternetReachable !== false;
        const key = `${state.type ?? "?"}:${reachable}`;
        const changed = key !== this.lastNetworkKey;
        this.lastNetworkKey = key;
        // Só reconecta quando a rede realmente mudou (Wi-Fi ↔ 4G) ou voltou; evita derrubar uma conexão saudável.
        if (reachable && (changed || this.status !== "live")) { this.attempt = 0; this.dropSocket(); void this.connect(); }
      });
    } catch { /* plataforma sem listener: o watchdog/backoff cuida da reconexão */ }
    // Watchdog: sem nenhuma mensagem (nem batimento) por 70 s = conexão morta sem "close" (comum ao trocar de rede).
    this.watchdog = setInterval(() => {
      if (!this.wanted) return;
      if (this.ws && Date.now() - this.lastMessageAt > 70_000) { this.dropSocket(); this.setStatus("offline"); this.attempt = 0; void this.connect(); }
      else if (!this.ws && !this.retryTimer) void this.connect();
    }, 15_000);
    void this.connect();
  }

  stop() {
    this.wanted = false;
    this.appStateSub?.remove(); this.appStateSub = null;
    this.netSub?.remove(); this.netSub = null;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this.dropSocket();
    this.setStatus("offline");
  }

  private dropSocket() {
    const socket = this.ws;
    this.ws = null;
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; try { socket.close(); } catch { /* já fechado */ } }
  }

  private scheduleRetry() {
    if (!this.wanted) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 500;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
  }

  private async connect() {
    if (!this.wanted) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connecting) return; // evita dois sockets quando vários eventos (rede, app, timer) disparam juntos
    this.connecting = true;
    let token: string | null = null;
    try { token = await Auth.getSessionToken(); } finally { this.connecting = false; }
    if (!this.wanted) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!token) { this.setStatus("offline"); return; }
    this.setStatus("connecting");
    let socket: WebSocket;
    try { socket = new WebSocket(getWsUrl()); } catch { this.setStatus("offline"); this.scheduleRetry(); return; }
    this.ws = socket;
    this.lastMessageAt = Date.now();
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
    socket.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      try {
        const message = JSON.parse(String(event.data)) as { type: string; scopes?: RealtimeScope[] };
        if (message.type === "ready") { this.attempt = 0; this.setStatus("live"); this.scopeListeners.forEach((l) => l(["requests", "announcements", "notifications", "suggestions", "me"])); }
        else if (message.type === "ping") { try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* onclose cuida */ } }
        else if (message.type === "invalidate" && message.scopes) this.scopeListeners.forEach((l) => l(message.scopes!));
      } catch { /* mensagem inválida ignorada */ }
    };
    socket.onclose = (event) => {
      if (this.ws !== socket) return; // evento de um socket antigo já descartado
      this.ws = null;
      this.setStatus("offline");
      const code = (event as { code?: number }).code;
      if (code === 4401) { this.attempt = Math.max(this.attempt, 4); } // não autorizado/ainda não aprovado: espera mais
      else if (code === 1012) { this.attempt = 0; } // servidor reiniciando: tenta de novo logo
      this.scheduleRetry();
    };
    socket.onerror = () => { /* onclose cuida do retry */ };
  }
}

export const realtime = new RealtimeClient();
