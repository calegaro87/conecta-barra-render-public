import Constants from "expo-constants";
import * as ReactNative from "react-native";

/**
 * URL pública do backend (HTTPS). Definida em tempo de compilação:
 *  - EAS: eas.json → build.<perfil>.env.EXPO_PUBLIC_API_URL
 *  - local: arquivo .env ou variável de ambiente antes de `expo prebuild`/`expo start`
 * Como é uma URL pública (https://api.seudominio.com.br), o app funciona em qualquer rede e dispositivo.
 */
const PRODUCTION_API_URL = "https://conecta-barra-api.onrender.com";
const configured = (process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "").trim();

export function getApiBaseUrl(): string {
  if (configured) return configured.replace(/\/$/, "");
  if (ReactNative.Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  // Emulador Android acessa o PC pelo 10.0.2.2 (APENAS desenvolvimento). Em build de release nunca cai aqui.
  if (!__DEV__) return PRODUCTION_API_URL;
  return "http://10.0.2.2:3000";
}

/** wss://… (ou ws://… em desenvolvimento) para o canal de tempo real. */
export function getWsUrl(): string {
  return `${getApiBaseUrl().replace(/^http/, "ws")}/ws`;
}

export const SESSION_TOKEN_KEY = "conecta_session_token";
export const USER_INFO_KEY = "conecta_user_info";
