// Carrega variáveis de ambiente (.env) sem sobrescrever as do sistema/EAS.
import "./scripts/load-env.js";
import { existsSync } from "node:fs";
import type { ExpoConfig } from "expo/config";

const PACKAGE_ID = "com.conectabarra.app"; // troque se tiver um domínio próprio (ex.: br.com.suaempresa.conectabarra)
// Valores padrão de PRODUÇÃO. Importante: `eas update` (OTA) roda na sua máquina e NÃO lê o `env` do eas.json.
// Sem estes padrões, uma atualização OTA publicada sem .env sairia sem `updates.url` e com a API apontando
// para http://10.0.2.2:3000, quebrando o app de todos os usuários. Mantenha iguais aos do eas.json.
const DEFAULT_API_URL = "https://conecta-barra-api.onrender.com";
const DEFAULT_EAS_PROJECT_ID = "c87bc760-536b-44e8-bf16-06ea027209d0";
const projectId = (process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || DEFAULT_EAS_PROJECT_ID);
// Em `expo start` (NODE_ENV=development) mantém o servidor local; em build/OTA usa a produção.
const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || (process.env.NODE_ENV === "development" ? "" : DEFAULT_API_URL);

const config: ExpoConfig = {
  name: "Conecta Barra",
  slug: "conecta-barra",
  owner: "conectabarras-team",
  version: "1.0.4",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "conectabarra",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  // Atualizações OTA reais (EAS Update). Ficam ativas assim que o projeto EAS for criado (eas init).
  ...(projectId ? { runtimeVersion: { policy: "appVersion" as const }, updates: { url: `https://u.expo.dev/${projectId}`, fallbackToCacheTimeout: 0, checkAutomatically: "ON_LOAD" as const } } : {}),
  ios: { supportsTablet: true, bundleIdentifier: PACKAGE_ID, infoPlist: { ITSAppUsesNonExemptEncryption: false } },
  android: {
    package: PACKAGE_ID,
    versionCode: 5,
    adaptiveIcon: {
      backgroundImage: "./assets/images/android-icon-background.png",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    edgeToEdgeEnabled: true,
    softwareKeyboardLayoutMode: "resize",
    predictiveBackGestureEnabled: false,
    // Obrigatório para push (FCM). Baixe do Firebase Console e coloque na raiz do projeto. Veja README.
    ...(process.env.GOOGLE_SERVICES_JSON
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
      : existsSync("./google-services.json")
        ? { googleServicesFile: "./google-services.json" }
        : {}),
    permissions: ["POST_NOTIFICATIONS", "USE_BIOMETRIC", "USE_FINGERPRINT"],
    // O app não grava áudio nem desenha sobre outros apps; remove permissões desnecessárias herdadas de bibliotecas.
    blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.SYSTEM_ALERT_WINDOW"],
    // Sem "cleartext": apenas HTTPS/WSS em produção.
  },
  web: { bundler: "metro", output: "static", favicon: "./assets/images/favicon.png" },
  extra: { eas: projectId ? { projectId } : undefined, apiUrl, brandName: "Conecta Barra" },
  plugins: [
    "expo-router",
    ["expo-notifications", { icon: "./assets/images/notification-icon.png", color: "#0B5FD8", defaultChannel: "conecta-alerts" }],
    ["expo-local-authentication", { faceIDPermission: "Permitir que o Conecta Barra use o Face ID para proteger sua conta." }],
    ["expo-splash-screen", { image: "./assets/images/splash-icon.png", imageWidth: 220, resizeMode: "contain", backgroundColor: "#0B5FD8", dark: { backgroundColor: "#062B5E" } }],
    ["expo-build-properties", { android: { minSdkVersion: 24 } }],
    "expo-secure-store",
    "expo-updates",
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
