function required(name: string, fallback?: string) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) {
    console.warn(`[env] Variável ${name} não definida.`);
    return "";
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";
const jwt = required("JWT_SECRET", isProduction ? undefined : "dev-only-secret-change-me");
if (isProduction && jwt.length < 32) {
  throw new Error("JWT_SECRET precisa ter pelo menos 32 caracteres em produção.");
}
const dataEncryptionKey = process.env.DATA_ENCRYPTION_KEY?.trim() ?? "";
if (isProduction && !dataEncryptionKey) {
  throw new Error("DATA_ENCRYPTION_KEY precisa ser configurada em produção antes de iniciar a API.");
}

const publicUrl = process.env.PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || "";

export const ENV = {
  isProduction,
  cookieSecret: jwt,
  dataEncryptionKey,
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL?.trim().toLowerCase() === "true",
  /** URL pública do backend. No Render, usa automaticamente RENDER_EXTERNAL_URL. */
  publicUrl: publicUrl.replace(/\/$/, ""),
  /** Origens de navegador autorizadas (separadas por vírgula). O app nativo não precisa. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean),
  cookieDomain: process.env.COOKIE_DOMAIN?.trim() || undefined,
  adminUsername: process.env.ADMIN_USERNAME?.trim() ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN?.trim() ?? "",
  googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID?.trim() ?? "",
  googleAndroidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID?.trim() ?? "",
  whatsappUrl: process.env.OFFICIAL_WHATSAPP_URL?.trim() ?? "",
};
