import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import * as db from "./db";
import { storagePut } from "./storage";
import { notifyAnnouncement, notifyNewRequest, notifyNewSuggestion, notifyResidentRegistration, notifyResidentStatus, notifyRequestStatusChanged, notifySuggestionUpdated, notifyTestPush } from "./push";
import { COOKIE_NAME } from "../shared/const";
import { emit, refreshClientProfile } from "./realtime";
import { lookupCep } from "./cep";
import { fetchPortalNews } from "./portal";
import { ENV } from "./_core/env";
import { CATEGORY_VALUES } from "../shared/categories";
import { composeAddress, matchNeighborhood, normalizeName } from "../shared/neighborhoods";
import { OFFICIAL_CHANNELS } from "../shared/official";
import { sendNewRegistrationAdminEmail, sendPasswordResetEmail, sendVerificationEmail } from "./email";
import { createRemoteJWKSet, jwtVerify } from "jose";

const categorySchema = z.enum(CATEGORY_VALUES);
const addressSchema = {
  cep: z.string().regex(/^\d{5}-?\d{3}$/, "Informe um CEP válido."),
  street: z.string().min(2).max(255),
  number: z.string().min(1).max(20),
  neighborhood: z.string().min(2).max(120),
  complement: z.string().max(255).optional(),
};

/** Garante que o bairro informado existe na lista da cidade (ou o cadastra quando veio de CEP válido). */
async function canonicalNeighborhood(name: string) {
  const known = (await db.listNeighborhoods(false)).map((item) => item.name);
  return matchNeighborhood(name, known) ?? name.trim();
}
const statusSchema = z.enum(["received", "reviewing", "forwarded", "in_progress", "completed", "cancelled"]);
const residentStatusSchema = z.enum(["pending", "approved", "blocked"]);
const scrypt = promisify(scryptCallback);

function ensureApprovedResident(user: { role: "user" | "admin"; residentStatus: "pending" | "approved" | "blocked" }) {
  if (user.role === "user" && user.residentStatus === "blocked") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Seu cadastro está bloqueado. Procure a gestão do Conecta Barra." });
  }
}

async function ensureResidentProfileComplete(user: { id: number; role: "user" | "admin"; residentStatus: "pending" | "approved" | "blocked" }) {
  ensureApprovedResident(user);
  if (user.role !== "user") return;
  const credential = await db.getResidentCredentialByUserId(user.id);
  const complete = Boolean(credential?.username && credential.address && credential.cep && credential.street && credential.number && credential.neighborhood && credential.phone && credential.sex);
  if (!complete) throw new TRPCError({ code: "FORBIDDEN", message: "Complete seus dados cadastrais no perfil antes de usar os serviços." });
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

type AdminAuditInput = {
  action: string;
  targetType: string;
  targetId?: number;
  targetUserId?: number;
  summary: string;
  metadata?: Record<string, unknown>;
};

async function recordAdminAction(adminId: number, input: AdminAuditInput) {
  await db.createAdminAuditLog({
    adminId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetUserId: input.targetUserId ?? null,
    summary: input.summary.slice(0, 500),
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
}

async function persistSession(userId: number, token: string, req: { headers: Record<string, string | string[] | undefined> }) {
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "Dispositivo não identificado";
  const platform = typeof req.headers["x-platform"] === "string" ? req.headers["x-platform"] : "web/native";
  const deviceLabel = (typeof req.headers["x-device-name"] === "string" ? req.headers["x-device-name"] : userAgent).slice(0, 120);
  await db.createAuthSession({ userId, tokenHash: createHash("sha256").update(token).digest("hex"), deviceLabel, platform: platform.slice(0, 32), expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [salt, storedHex] = encoded.split(":");
  if (!salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, "hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

export const appRouter = router({
  system: systemRouter,
  admin: router({
    dashboard: adminProcedure.input(z.object({ neighborhood: z.string().max(120).optional() }).optional()).query(({ ctx, input }) => db.getAdminDashboardSummary(ctx.user.id, input?.neighborhood)),
    emailDelivery: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(250).optional() }).optional()).query(({ input }) => db.listEmailDeliveryLogs(input?.limit ?? 100)),
  }),
  auth: router({
    register: publicProcedure.input(z.object({ username: z.string().min(4).max(64).regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(8).max(128), name: z.string().min(3).max(120), email: z.string().email().optional(), ...addressSchema, phone: z.string().min(8).max(32), sex: z.enum(["female", "male", "non_binary", "prefer_not_to_say"]) })).mutation(async ({ ctx, input }) => {
      const username = input.username.trim().toLowerCase();
      const email = input.email?.trim().toLowerCase() ?? "";
      if (await db.getResidentCredentialByUsername(username)) throw new TRPCError({ code: "CONFLICT", message: "Este nome de usuário já está em uso." });
      if (email && await db.getResidentCredentialByEmail(email)) throw new TRPCError({ code: "CONFLICT", message: "Este e-mail já está cadastrado." });
      const neighborhood = await canonicalNeighborhood(input.neighborhood);
      const address = composeAddress({ street: input.street, number: input.number, complement: input.complement, neighborhood, cep: input.cep });
      const openId = `local_${username}`;
      await db.upsertUser({ openId, name: input.name, email: email || null, loginMethod: "local", role: "user", residentStatus: "approved", lastSignedIn: new Date() });
      const user = await db.getUserByOpenId(openId);
      if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o usuário." });
      try {
        await db.createResidentCredential({ userId: user.id, username, passwordHash: await hashPassword(input.password), address, cep: input.cep, street: input.street, number: input.number, neighborhood, complement: input.complement ?? null, phone: input.phone, sex: input.sex, email: email || null });
        if (!email) {
          const token = await sdk.signSession({ openId, appId: "conecta-barra", name: input.name });
          await persistSession(user.id, token, ctx.req);
          ctx.res.cookie("app_session_id", token, getSessionCookieOptions(ctx.req));
          return { user, token, username, email, verificationRequired: false } as const;
        }
        const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
        await db.createEmailVerificationCode({ userId: user.id, email, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), attempts: 0 });
        await sendVerificationEmail({ name: input.name, email, code, userId: user.id });
      } catch (error) {
        await db.deleteResident(user.id).catch(() => undefined);
        console.warn("[Registration] Could not send verification email:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível enviar o código de confirmação. Confira o e-mail e tente novamente." });
      }
      return { success: true, username, email, verificationRequired: true } as const;
    }),
    verifyEmail: publicProcedure.input(z.object({ username: z.string().min(4).max(64), code: z.string().regex(/^\d{6}$/) })).mutation(async ({ input }) => {
      const username = input.username.trim().toLowerCase();
      const credential = await db.getResidentCredentialByUsername(username);
      if (!credential?.email || !credential.userId) throw new TRPCError({ code: "NOT_FOUND", message: "Cadastro pendente não encontrado." });
      if (credential.emailVerifiedAt) return { success: true, alreadyVerified: true } as const;
      const challenge = await db.getLatestEmailVerificationCode(credential.userId);
      if (!challenge || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= 5) throw new TRPCError({ code: "BAD_REQUEST", message: "O código expirou ou excedeu o limite de tentativas. Solicite um novo código." });
      if (!(await verifyPassword(input.code, challenge.codeHash))) { await db.incrementEmailVerificationAttempts(challenge.id); throw new TRPCError({ code: "UNAUTHORIZED", message: "Código de confirmação incorreto." }); }
      await db.consumeEmailVerificationCode(challenge.id);
      await db.markResidentEmailVerified(credential.userId);
      const user = await db.getUserByOpenId(`local_${username}`);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Usuário não encontrado." });
      void notifyResidentRegistration({ userId: user.id, residentName: user.name ?? username });
      let adminEmailSent = false;
      try {
        await sendNewRegistrationAdminEmail({ userId: user.id, name: user.name ?? username, username, email: credential.email, address: credential.address ?? "Não informado", phone: credential.phone ?? "Não informado", sex: credential.sex });
        adminEmailSent = true;
      } catch (error) {
        console.warn("[Registration] Could not notify administrator by email:", error);
      }
      return { success: true, alreadyVerified: false, adminEmailSent } as const;
    }),
    resendVerification: publicProcedure.input(z.object({ username: z.string().min(4).max(64) })).mutation(async ({ input }) => {
      const username = input.username.trim().toLowerCase();
      const credential = await db.getResidentCredentialByUsername(username);
      if (!credential?.email || credential.emailVerifiedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Não há confirmação pendente para este usuário." });
      const previous = await db.getLatestEmailVerificationCode(credential.userId);
      if (previous && Date.now() - previous.createdAt.getTime() < 60_000) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Aguarde um minuto antes de solicitar outro código." });
      const user = await db.getUserByOpenId(`local_${username}`);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Usuário não encontrado." });
      const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
      await db.createEmailVerificationCode({ userId: credential.userId, email: credential.email, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), attempts: 0 });
      await sendVerificationEmail({ name: user.name ?? username, email: credential.email, code, userId: credential.userId });
      return { success: true } as const;
    }),
    requestPasswordReset: publicProcedure.input(z.object({ username: z.string().min(4).max(64) })).mutation(async ({ input }) => {
      const username = input.username.trim().toLowerCase();
      const credential = await db.getResidentCredentialByUsername(username);
      if (credential?.email && credential.emailVerifiedAt) {
        const previous = await db.getLatestPasswordResetCode(credential.userId);
        if (previous && Date.now() - previous.createdAt.getTime() < 60_000) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Aguarde um minuto antes de solicitar outro código." });
        const user = await db.getUserByOpenId(`local_${username}`);
        if (user) {
          const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
          await db.createPasswordResetCode({ userId: credential.userId, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), attempts: 0 });
          await sendPasswordResetEmail({ name: user.name ?? username, email: credential.email, code, userId: user.id });
        }
      }
      return { success: true } as const;
    }),
    resetPassword: publicProcedure.input(z.object({ username: z.string().min(4).max(64), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(8).max(128) })).mutation(async ({ input }) => {
      const username = input.username.trim().toLowerCase();
      const credential = await db.getResidentCredentialByUsername(username);
      const challenge = credential ? await db.getLatestPasswordResetCode(credential.userId) : undefined;
      if (!credential || !challenge || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= 5 || !(await verifyPassword(input.code, challenge.codeHash))) {
        if (challenge && challenge.attempts < 5) await db.incrementPasswordResetAttempts(challenge.id);
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Código inválido ou expirado. Solicite um novo código." });
      }
      await db.updateResidentPassword(credential.userId, await hashPassword(input.newPassword));
      await db.consumePasswordResetCode(challenge.id);
      await db.revokeAllAuthSessions(credential.userId);
      return { success: true } as const;
    }),
    login: publicProcedure.input(z.object({ username: z.string().min(4).max(128), password: z.string().min(4).max(128) })).mutation(async ({ ctx, input }) => {
      const username = input.username.trim();
      const configuredAdminUsername = ENV.adminUsername || "@educalegaro";
      const configuredAdminPassword = ENV.adminPassword;
      const normalizedAdminUsername = username.replace(/^@+/, "").toLocaleLowerCase("pt-BR");
      const normalizedConfiguredAdminUsername = configuredAdminUsername.replace(/^@+/, "").toLocaleLowerCase("pt-BR");
      if (configuredAdminUsername && configuredAdminPassword && normalizedAdminUsername === normalizedConfiguredAdminUsername && input.password === configuredAdminPassword) {
        const openId = `admin_${normalizedConfiguredAdminUsername}`;
        await db.upsertUser({ openId, name: "Gestão Conecta Barra", loginMethod: "local-admin", role: "admin", residentStatus: "approved", lastSignedIn: new Date() });
        const user = await db.getUserByOpenId(openId);
        if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acesso administrativo." });
        const token = await sdk.signSession({ openId, appId: "conecta-barra", name: user.name ?? "Gestão" });
        await persistSession(user.id, token, ctx.req);
        ctx.res.cookie("app_session_id", token, getSessionCookieOptions(ctx.req));
        return { user, token };
      }
      const normalizedUsername = username.toLowerCase();
      const credential = await db.getResidentCredentialByUsername(normalizedUsername);
      if (!credential || !(await verifyPassword(input.password, credential.passwordHash))) throw new TRPCError({ code: "UNAUTHORIZED", message: "Usuário ou senha inválidos." });
      const user = await db.getUserByOpenId(`local_${normalizedUsername}`);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Usuário não encontrado." });
      const pendingEmailVerification = credential.email ? await db.getLatestEmailVerificationCode(user.id) : undefined;
      if (pendingEmailVerification && !credential.emailVerifiedAt) throw new TRPCError({ code: "FORBIDDEN", message: "Confirme seu e-mail pelo código recebido antes de entrar." });
      ensureApprovedResident(user);
      const token = await sdk.signSession({ openId: user.openId, appId: "conecta-barra", name: user.name ?? input.username });
      await persistSession(user.id, token, ctx.req);
      ctx.res.cookie("app_session_id", token, getSessionCookieOptions(ctx.req));
      return { user, token };
    }),
    loginGoogle: publicProcedure.input(z.object({ idToken: z.string().min(100).max(8192) })).mutation(async ({ ctx, input }) => {
      if (!ENV.googleWebClientId && !ENV.googleAndroidClientId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Login Google ainda não está configurado no servidor." });
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(input.idToken, googleKeys, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: [ENV.googleWebClientId, ENV.googleAndroidClientId].filter(Boolean),
        });
        payload = verified.payload as Record<string, unknown>;
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Token Google inválido ou expirado." });
      }
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (!sub || !email || payload.email_verified !== true) throw new TRPCError({ code: "UNAUTHORIZED", message: "A conta Google não forneceu um e-mail verificado." });
      const openId = `google_${sub}`;
      const existingByGoogle = await db.getUserByOpenId(openId);
      const existingCredential = await db.getResidentCredentialByEmail(email);
      let user = existingByGoogle ?? (existingCredential?.userId ? await db.getUserById(existingCredential.userId) : undefined) ?? await db.getUserByEmail(email);
      if (!user) {
        const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : email.split("@")[0];
        await db.upsertUser({ openId, name, email, loginMethod: "google", role: "user", residentStatus: "approved", lastSignedIn: new Date() });
        user = await db.getUserByOpenId(openId);
        if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acesso Google." });
        const username = `google_${sub}`.slice(0, 64);
        await db.createResidentCredential({ userId: user.id, username, passwordHash: await hashPassword(randomBytes(32).toString("hex")), address: null, cep: null, street: null, number: null, neighborhood: null, phone: "", sex: "prefer_not_to_say", email, emailVerifiedAt: new Date() });
      } else {
        await db.upsertUser({ openId: user.openId, name: (typeof payload.name === "string" && payload.name.trim()) ? payload.name.trim() : user.name, email, loginMethod: "google", lastSignedIn: new Date() });
        user = await db.getUserById(user.id) ?? user;
        const credential = await db.getResidentCredentialByUserId(user.id);
        if (!credential) {
          await db.createResidentCredential({ userId: user.id, username: `google_${sub}`.slice(0, 64), passwordHash: await hashPassword(randomBytes(32).toString("hex")), address: null, cep: null, street: null, number: null, neighborhood: null, phone: "", sex: "prefer_not_to_say", email, emailVerifiedAt: new Date() });
        }
      }
      ensureApprovedResident(user);
      const token = await sdk.signSession({ openId: user.openId, appId: "conecta-barra", name: user.name ?? email });
      await persistSession(user.id, token, ctx.req);
      ctx.res.cookie("app_session_id", token, getSessionCookieOptions(ctx.req));
      const credential = await db.getResidentCredentialByUserId(user.id);
      return { user, token, profileComplete: Boolean(credential?.username && credential.address && credential.cep && credential.street && credential.number && credential.neighborhood && credential.phone && credential.sex) };
    }),
    me: publicProcedure.query(async (opts) => {
      if (!opts.ctx.user) return null;
      const credentials = opts.ctx.user.role === "user" ? await db.getResidentCredentialByUserId(opts.ctx.user.id) : undefined;
      return { ...opts.ctx.user, ...(credentials ?? {}) };
    }),
    updateAvatar: protectedProcedure.input(z.object({ photoDataBase64: z.string().min(100).max(4_194_304), photoContentType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg") })).mutation(async ({ ctx, input }) => {
      ensureApprovedResident(ctx.user);
      const stored = await storagePut(`avatars/${ctx.user.id}/${Date.now()}`, Buffer.from(input.photoDataBase64, "base64"), input.photoContentType);
      const user = await db.updateUserAvatar(ctx.user.id, stored.url);
      return { user, avatarUrl: stored.url };
    }),
    removeAvatar: protectedProcedure.mutation(async ({ ctx }) => {
      ensureApprovedResident(ctx.user);
      const user = await db.updateUserAvatar(ctx.user.id, null);
      return { user, avatarUrl: null };
    }),
    updateProfile: protectedProcedure.input(z.object({ name: z.string().min(3).max(120), ...addressSchema, phone: z.string().min(8).max(32), sex: z.enum(["female", "male", "non_binary", "prefer_not_to_say"]), email: z.string().email().optional().or(z.literal("")), householdSize: z.number().int().min(1).max(30).nullable().optional(), emergencyContact: z.string().max(255).optional() })).mutation(async ({ ctx, input }) => { ensureApprovedResident(ctx.user); const neighborhood = await canonicalNeighborhood(input.neighborhood); const address = composeAddress({ street: input.street, number: input.number, complement: input.complement, neighborhood, cep: input.cep }); const result = await db.updateResidentProfile(ctx.user.id, { ...input, neighborhood, address, email: input.email || null }); await refreshClientProfile(ctx.user.id); emit({ scopes: ["me", "announcements"], userIds: [ctx.user.id] }); return result; }),
    requestPasswordChangeConfirmation: protectedProcedure.input(z.object({ method: z.enum(["biometric", "code"]) })).mutation(async ({ ctx, input }) => {
      ensureApprovedResident(ctx.user);
      const code = input.method === "code" ? String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0") : randomBytes(32).toString("hex");
      const challengeId = await db.createPasswordChangeChallenge({ userId: ctx.user.id, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), attempts: 0 });
      return { challengeId, method: input.method, code: input.method === "code" ? code : undefined, proof: input.method === "biometric" ? code : undefined, expiresInSeconds: 600 } as const;
    }),
    confirmPasswordChange: protectedProcedure.input(z.object({ challengeId: z.number().int().positive(), proof: z.string().min(6).max(128) })).mutation(async ({ ctx, input }) => {
      ensureApprovedResident(ctx.user);
      const challenge = await db.getPasswordChangeChallenge(ctx.user.id, input.challengeId);
      if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= 5) throw new TRPCError({ code: "BAD_REQUEST", message: "A confirmação expirou ou não está disponível. Solicite um novo código." });
      if (!(await verifyPassword(input.proof, challenge.codeHash))) { await db.incrementPasswordChangeChallengeAttempts(challenge.id); throw new TRPCError({ code: "UNAUTHORIZED", message: "A confirmação adicional está incorreta." }); }
      await db.confirmPasswordChangeChallenge(challenge.id);
      return { success: true } as const;
    }),
    changePassword: protectedProcedure.input(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128), confirmationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { ensureApprovedResident(ctx.user); if (input.currentPassword === input.newPassword) throw new TRPCError({ code: "BAD_REQUEST", message: "A nova senha precisa ser diferente da atual." }); const currentHash = await db.getResidentPasswordHash(ctx.user.id); if (!currentHash || !(await verifyPassword(input.currentPassword, currentHash))) throw new TRPCError({ code: "UNAUTHORIZED", message: "A senha atual está incorreta." }); const confirmation = await db.getPasswordChangeChallenge(ctx.user.id, input.confirmationId); if (!confirmation || !confirmation.confirmedAt || confirmation.usedAt || confirmation.expiresAt.getTime() <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "Confirme a identidade novamente antes de trocar a senha." }); await db.updateResidentPassword(ctx.user.id, await hashPassword(input.newPassword)); await db.consumePasswordChangeChallenge(confirmation.id); return { success: true } as const; }),
    logout: publicProcedure.input(z.object({ pushToken: z.string().max(512).optional() }).optional()).mutation(async ({ ctx, input }) => {
      // Remove o token de push deste aparelho: sem isso, quem saiu da conta continuava recebendo notificações dela.
      if (ctx.user && input?.pushToken) await db.deleteNotificationToken(ctx.user.id, input.pushToken).catch(() => undefined);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      const expiredOptions = { ...cookieOptions, maxAge: -1 };
      ctx.res.clearCookie("app_session_id", expiredOptions);
      ctx.res.clearCookie(COOKIE_NAME, expiredOptions);
      return { success: true } as const;
    }),
    sessions: protectedProcedure.query(({ ctx }) => db.listAuthSessions(ctx.user.id)),
    revokeSession: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await db.revokeAuthSession(ctx.user.id, input.id); return { success: true } as const; }),
    revokeAllSessions: protectedProcedure.mutation(async ({ ctx }) => { await db.revokeAllAuthSessions(ctx.user.id); return { success: true } as const; }),
  }),
  notifications: router({
    registerDevice: protectedProcedure.input(z.object({ token: z.string().min(20).max(512), platform: z.enum(["android", "ios"]) })).mutation(({ ctx, input }) => db.upsertNotificationToken({ userId: ctx.user.id, token: input.token, platform: input.platform })),
    unregisterDevice: protectedProcedure.input(z.object({ token: z.string().min(20).max(512) })).mutation(({ ctx, input }) => db.deleteNotificationToken(ctx.user.id, input.token)),
    testPush: adminProcedure.mutation(({ ctx }) => notifyTestPush(ctx.user.id)),
    list: protectedProcedure.query(async ({ ctx }) => {
      await ensureResidentProfileComplete(ctx.user);
      const items = await db.listAppNotifications(ctx.user.id);
      return items.map((item) => ({
        ...item,
        data: item.data ? (() => { try { return JSON.parse(item.data); } catch { return {}; } })() : {},
      }));
    }),
    weeklySummary: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); return db.getWeeklyNotificationSummary(ctx.user.id); }),
    trash: protectedProcedure.query(async ({ ctx }) => {
      await ensureResidentProfileComplete(ctx.user);
      const items = await db.listTrashedAppNotifications(ctx.user.id);
      return items.map((item) => ({
        ...item,
        data: item.data ? (() => { try { return JSON.parse(item.data); } catch { return {}; } })() : {},
      }));
    }),
    markRead: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => db.markAppNotificationRead(ctx.user.id, input.id)),
    markAllRead: protectedProcedure.mutation(({ ctx }) => db.markAllAppNotificationsRead(ctx.user.id)),
    moveToTrash: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => db.moveAppNotificationToTrash(ctx.user.id, input.id)),
    moveToTrashMany: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) })).mutation(({ ctx, input }) => db.moveAppNotificationsToTrash(ctx.user.id, input.ids)),
    restore: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => db.restoreAppNotification(ctx.user.id, input.id)),
    restoreMany: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) })).mutation(({ ctx, input }) => db.restoreAppNotifications(ctx.user.id, input.ids)),
    deletePermanently: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => db.permanentlyDeleteAppNotification(ctx.user.id, input.id)),
    deletePermanentlyMany: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) })).mutation(({ ctx, input }) => db.permanentlyDeleteAppNotifications(ctx.user.id, input.ids)),
    // Compatibilidade com versões anteriores: o apagar antigo agora envia para a lixeira.
    delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => db.moveAppNotificationToTrash(ctx.user.id, input.id)),
    deleteMany: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) })).mutation(({ ctx, input }) => db.moveAppNotificationsToTrash(ctx.user.id, input.ids)),
    preferences: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); return db.listNotificationPreferences(ctx.user.id); }),
    updatePreference: protectedProcedure.input(z.object({ category: z.enum(["announcements", "requests", "suggestions", "account"]), enabled: z.boolean() })).mutation(async ({ ctx, input }) => { await ensureResidentProfileComplete(ctx.user); return db.upsertNotificationPreference(ctx.user.id, input.category, input.enabled); }),
  }),
  requests: router({
    mine: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); return db.listUserRequests(ctx.user.id); }),
    activity: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); const [residentRequests, statusUpdates] = await Promise.all([db.listUserRequests(ctx.user.id), db.listUserRequestUpdates(ctx.user.id)]); return { requests: residentRequests, updates: statusUpdates }; }),
    create: protectedProcedure.input(z.object({
      category: categorySchema,
      description: z.string().min(10).max(5000),
      fullAddress: z.string().min(5).max(1000),
      cep: z.string().regex(/^\d{5}-?\d{3}$/).optional(),
      neighborhood: z.string().min(2).max(120),
      referencePoint: z.string().max(500).optional(),
      photoUrl: z.string().url().optional(),
      photoDataBase64: z.string().max(4_194_304).optional(),
      photoContentType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
      clientOperationId: z.string().min(16).max(128).optional(),
    })).mutation(async ({ ctx, input }) => {
      await ensureResidentProfileComplete(ctx.user);
      const { photoDataBase64, photoContentType, clientOperationId, ...requestData } = input;
      if (clientOperationId) {
        const previous = await db.getClientOperation(ctx.user.id, clientOperationId);
        if (previous?.operation === "requests.create") {
          try { return JSON.parse(previous.result).requestId as number; } catch { /* registro antigo inválido: segue sem reutilizar */ }
        }
      }
      let photoUrl = requestData.photoUrl;
      if (photoDataBase64) {
        const stored = await storagePut(`requests/${ctx.user.id}/${Date.now()}.jpg`, Buffer.from(photoDataBase64, "base64"), photoContentType ?? "image/jpeg");
        photoUrl = stored.url;
      }
      const neighborhood = await canonicalNeighborhood(requestData.neighborhood);
      const requestId = await db.createRequest({ ...requestData, neighborhood, photoUrl, userId: ctx.user.id });
      if (clientOperationId) await db.saveClientOperation({ userId: ctx.user.id, operationId: clientOperationId, operation: "requests.create", result: JSON.stringify({ requestId }) });
      emit({ scopes: ["requests", "dashboard"], userIds: [ctx.user.id], admins: true });
      void notifyNewRequest({ requestId, residentName: ctx.user.name ?? undefined, category: input.category, neighborhood });
      return requestId;
    }),
    all: adminProcedure.input(z.object({ status: statusSchema.optional(), category: categorySchema.optional(), neighborhood: z.string().max(120).optional() }).optional()).query(({ input }) => db.listAllRequests(input)),
    updateStatus: adminProcedure.input(z.object({ id: z.number().int().positive(), status: statusSchema, message: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => {
      const userId = await db.updateRequestStatus({ ...input, adminId: ctx.user.id });
      await notifyRequestStatusChanged({ userId, requestId: input.id, status: input.status, message: input.message });
      emit({ scopes: ["requests", "dashboard"], admins: true });
      void recordAdminAction(ctx.user.id, { action: "request_status", targetType: "request", targetId: input.id, targetUserId: userId, summary: `Solicitação #${input.id} alterada para ${input.status}.`, metadata: { status: input.status, message: input.message ?? null } });
      return { success: true } as const;
    }),
    delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const targetUserId = await db.getRequestOwnerId(input.id);
      await db.deleteRequest(input.id);
      emit({ scopes: ["requests", "dashboard"], admins: true, userIds: targetUserId ? [targetUserId] : [] });
      void recordAdminAction(ctx.user.id, { action: "request_delete", targetType: "request", targetId: input.id, targetUserId, summary: `Solicitação #${input.id} excluída.`, metadata: {} });
      return { success: true } as const;
    }),
    deleteMany: adminProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) })).mutation(async ({ ctx, input }) => {
      for (const id of input.ids) {
        const targetUserId = await db.getRequestOwnerId(id);
        await db.deleteRequest(id);
        emit({ scopes: ["requests", "dashboard"], admins: true, userIds: targetUserId ? [targetUserId] : [] });
        void recordAdminAction(ctx.user.id, { action: "request_delete", targetType: "request", targetId: id, targetUserId, summary: `Solicitação #${id} excluída.`, metadata: { bulk: true } });
      }
      return { success: true, count: input.ids.length } as const;
    }),
    updateMine: protectedProcedure.input(z.object({ id: z.number().int().positive(), category: categorySchema, description: z.string().min(10).max(5000), fullAddress: z.string().min(5).max(1000), referencePoint: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => { await ensureResidentProfileComplete(ctx.user); const { id, ...data } = input; return db.updateOwnRequest(ctx.user.id, id, data); }),
  }),
  suggestions: router({
    mine: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); return db.listUserSuggestions(ctx.user.id); }),
    create: protectedProcedure.input(z.object({ title: z.string().min(3).max(255), description: z.string().min(10).max(5000), photoUrl: z.string().url().optional() })).mutation(async ({ ctx, input }) => { await ensureResidentProfileComplete(ctx.user); const neighborhood = await db.getUserNeighborhood(ctx.user.id); const suggestionId = await db.createSuggestion({ ...input, neighborhood, userId: ctx.user.id }); emit({ scopes: ["suggestions", "dashboard"], admins: true, userIds: [ctx.user.id] }); void notifyNewSuggestion({ suggestionId, residentName: ctx.user.name ?? undefined, title: input.title }); return suggestionId; }),
    update: adminProcedure.input(z.object({ id: z.number().int().positive(), title: z.string().min(3).max(255), description: z.string().min(10).max(5000) })).mutation(async ({ ctx, input }) => { const userId = await db.getSuggestionOwnerId(input.id); await db.updateSuggestion(input.id, { title: input.title, description: input.description }); if (userId) void notifySuggestionUpdated({ userId, suggestionId: input.id, title: input.title }); void recordAdminAction(ctx.user.id, { action: "suggestion_update", targetType: "suggestion", targetId: input.id, targetUserId: userId, summary: `Sugestão #${input.id} atualizada.`, metadata: { title: input.title } }); return { success: true } as const; }),
    updateMine: protectedProcedure.input(z.object({ id: z.number().int().positive(), title: z.string().min(3).max(255), description: z.string().min(10).max(5000) })).mutation(async ({ ctx, input }) => { await ensureResidentProfileComplete(ctx.user); return db.updateOwnSuggestion(ctx.user.id, input.id, { title: input.title, description: input.description }); }),
    delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const targetUserId = await db.getSuggestionOwnerId(input.id); await db.deleteSuggestion(input.id); void recordAdminAction(ctx.user.id, { action: "suggestion_delete", targetType: "suggestion", targetId: input.id, targetUserId, summary: `Sugestão #${input.id} excluída.`, metadata: {} }); return { success: true } as const; }),
    all: adminProcedure.input(z.object({ neighborhood: z.string().max(120).optional() }).optional()).query(async ({ input }) => {
      const database = await db.getDb();
      if (!database) return [];
      const { suggestions } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      return database.select().from(suggestions).where(input?.neighborhood ? eq(suggestions.neighborhood, input.neighborhood) : undefined);
    }),
  }),
  announcements: router({
    list: protectedProcedure.query(async ({ ctx }) => { await ensureResidentProfileComplete(ctx.user); const credential = ctx.user.role === "user" ? await db.getResidentCredentialByUserId(ctx.user.id) : undefined; return db.listAnnouncements(ctx.user.id, ctx.user.role, credential?.neighborhood); }),
    like: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await ensureResidentProfileComplete(ctx.user); const result = await db.toggleAnnouncementLike(input.id, ctx.user.id); emit({ scopes: ["announcements"], everyone: true }); return result; }),
    likeUsers: adminProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => db.listAnnouncementLikeUsers(input.id)),
    create: adminProcedure.input(z.object({ title: z.string().min(3).max(255), content: z.string().min(10).max(10000), category: z.enum(["event", "notice", "urgent", "general", "civil_defense"]), audience: z.enum(["all", "residents", "admins"]).default("all"), neighborhood: z.string().max(120).optional() })).mutation(async ({ ctx, input }) => { const announcementId = await db.createAnnouncement({ ...input, neighborhood: input.neighborhood?.trim() || null, adminId: ctx.user.id }); emit({ scopes: ["announcements"], neighborhood: input.neighborhood?.trim() || null });
 void notifyAnnouncement({ announcementId, title: input.title, category: input.category, neighborhood: input.neighborhood?.trim() || null }); void recordAdminAction(ctx.user.id, { action: "announcement_create", targetType: "announcement", targetId: announcementId, summary: `Comunicado “${input.title}” publicado.`, metadata: { category: input.category, audience: input.audience, neighborhood: input.neighborhood ?? null } }); return announcementId; }),
    update: adminProcedure.input(z.object({ id: z.number().int().positive(), title: z.string().min(3).max(255), content: z.string().min(10).max(10000), category: z.enum(["event", "notice", "urgent", "general", "civil_defense"]), audience: z.enum(["all", "residents", "admins"]).default("all"), neighborhood: z.string().max(120).optional() })).mutation(async ({ ctx, input }) => { await db.updateAnnouncement(input.id, { title: input.title, content: input.content, category: input.category, audience: input.audience, neighborhood: input.neighborhood?.trim() || null }); emit({ scopes: ["announcements"], everyone: true });
 void notifyAnnouncement({ announcementId: input.id, title: `Comunicado atualizado: ${input.title}`, category: input.category, neighborhood: input.neighborhood?.trim() || null }); void recordAdminAction(ctx.user.id, { action: "announcement_update", targetType: "announcement", targetId: input.id, summary: `Comunicado #${input.id} atualizado.`, metadata: { category: input.category, audience: input.audience, neighborhood: input.neighborhood ?? null } }); return { success: true } as const; }),
    delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await db.deleteAnnouncement(input.id); emit({ scopes: ["announcements"], everyone: true }); void recordAdminAction(ctx.user.id, { action: "announcement_delete", targetType: "announcement", targetId: input.id, summary: `Comunicado #${input.id} excluído.`, metadata: {} }); return { success: true } as const; }),
  }),
  users: router({
    all: adminProcedure.input(z.object({ neighborhood: z.string().max(120).optional() }).optional()).query(({ input }) => db.listUsers(input?.neighborhood)),
    updateStatus: adminProcedure.input(z.object({ userId: z.number().int().positive(), residentStatus: residentStatusSchema })).mutation(async ({ ctx, input }) => { const result = await db.updateResidentStatus(input.userId, input.residentStatus); emit({ scopes: ["residents", "dashboard", "me"], admins: true, userIds: [input.userId] }); void notifyResidentStatus(result); void recordAdminAction(ctx.user.id, { action: "user_status", targetType: "user", targetId: input.userId, targetUserId: input.userId, summary: `Status do usuário #${input.userId} alterado para ${input.residentStatus}.`, metadata: { residentStatus: input.residentStatus } }); return result; }),
    delete: adminProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await db.deleteResident(input.userId); emit({ scopes: ["residents", "dashboard"], admins: true }); void recordAdminAction(ctx.user.id, { action: "user_delete", targetType: "user", targetId: input.userId, targetUserId: input.userId, summary: `Cadastro do usuário #${input.userId} excluído.`, metadata: {} }); return { success: true } as const; }),
  }),
  residents: router({
    all: adminProcedure.input(z.object({ neighborhood: z.string().max(120).optional() }).optional()).query(({ input }) => db.listResidents(input?.neighborhood)),
    updateStatus: adminProcedure.input(z.object({ userId: z.number().int().positive(), residentStatus: residentStatusSchema })).mutation(async ({ ctx, input }) => { const result = await db.updateResidentStatus(input.userId, input.residentStatus); emit({ scopes: ["residents", "dashboard", "me"], admins: true, userIds: [input.userId] }); void notifyResidentStatus(result); void recordAdminAction(ctx.user.id, { action: "user_status", targetType: "user", targetId: input.userId, targetUserId: input.userId, summary: `Status do morador #${input.userId} alterado para ${input.residentStatus}.`, metadata: { residentStatus: input.residentStatus } }); return result; }),
    delete: adminProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await db.deleteResident(input.userId); emit({ scopes: ["residents", "dashboard"], admins: true }); void recordAdminAction(ctx.user.id, { action: "user_delete", targetType: "user", targetId: input.userId, targetUserId: input.userId, summary: `Cadastro do morador #${input.userId} excluído.`, metadata: {} }); return { success: true } as const; }),
    resetPassword: adminProcedure.input(z.object({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const credential = await db.getResidentCredentialByUserId(input.userId);
      if (!credential) throw new TRPCError({ code: "NOT_FOUND", message: "Este cadastro não possui credencial de morador." });
      const temporaryPassword = `CB-${randomBytes(5).toString("hex").toUpperCase()}`;
      await db.updateResidentPassword(input.userId, await hashPassword(temporaryPassword));
      void recordAdminAction(ctx.user.id, { action: "user_password_reset", targetType: "user", targetId: input.userId, targetUserId: input.userId, summary: `Senha temporária gerada para o morador #${input.userId}.`, metadata: { delivery: "manual" } });
      return { username: credential.username, temporaryPassword } as const;
    }),
  }),
  audit: router({
    list: adminProcedure.input(z.object({ targetUserId: z.number().int().positive().optional(), action: z.string().max(64).optional(), limit: z.number().int().min(1).max(250).optional() }).optional()).query(({ input }) => db.listAdminAuditLogs(input)),
    delete: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await db.deleteAdminAuditLog(input.id); return { success: true } as const; }),
    deleteMany: adminProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(250) })).mutation(async ({ input }) => { await db.deleteAdminAuditLogs(input.ids); return { success: true, count: input.ids.length } as const; }),
  }),
  telemetry: router({
    record: protectedProcedure.input(z.object({
      endpoint: z.string().min(1).max(240),
      method: z.string().min(1).max(12),
      status: z.number().int().min(0).max(999).nullable().optional(),
      errorCode: z.string().max(64).nullable().optional(),
      message: z.string().min(1).max(240),
      durationMs: z.number().int().min(0).max(2_147_483_647),
      platform: z.enum(["android", "ios", "web", "unknown"]),
      appVersion: z.string().min(1).max(32),
    })).mutation(async ({ ctx, input }) => {
      const id = await db.createNetworkTelemetryEvent({
        userId: ctx.user.id,
        ...input,
        status: input.status ?? null,
        errorCode: input.errorCode ?? null,
      });
      return { success: true, id } as const;
    }),
    list: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(250).optional() }).optional()).query(({ input }) => db.listNetworkTelemetryEvents(input?.limit)),
  }),
  social: router({
    get: publicProcedure.query(async () => { const saved = await db.getSocialLinks(); return { website: saved.website || OFFICIAL_CHANNELS.website, instagram: saved.instagram || OFFICIAL_CHANNELS.instagram, facebook: saved.facebook || OFFICIAL_CHANNELS.facebook, youtube: saved.youtube || OFFICIAL_CHANNELS.youtube, whatsapp: saved.whatsapp || ENV.whatsappUrl || OFFICIAL_CHANNELS.whatsapp || null }; }),
    update: adminProcedure.input(z.object({ instagram: z.string().url().or(z.literal("")), facebook: z.string().url().or(z.literal("")), whatsapp: z.string().url().or(z.literal("")), youtube: z.string().url().or(z.literal("")).optional(), website: z.string().url().or(z.literal("")).optional() })).mutation(async ({ input }) => { const result = await db.updateSocialLinks({ instagram: input.instagram || null, facebook: input.facebook || null, whatsapp: input.whatsapp || null, youtube: input.youtube || null, website: input.website || null }); emit({ scopes: ["social"], everyone: true }); return result; }),
  }),
  reports: router({
    waterShortage: adminProcedure.input(z.object({ neighborhood: z.string().max(120).optional() }).optional()).query(({ input }) => db.listWaterShortageRequests(input?.neighborhood)),
    markWaterShortageAttended: adminProcedure.input(z.object({ id: z.number().int().positive(), attended: z.boolean() })).mutation(async ({ input }) => { const result = await db.markWaterShortageAttended(input.id, input.attended); void notifyRequestStatusChanged(result); return result; }),
  }),
  address: router({
    /** Busca automática de endereço por CEP (público: usado também no cadastro). */
    lookupCep: publicProcedure.input(z.object({ cep: z.string().regex(/^\d{5}-?\d{3}$/, "Informe um CEP com 8 dígitos.") })).query(async ({ input }) => {
      let result;
      try { result = await lookupCep(input.cep); } catch (error) { throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error instanceof Error ? error.message : "Serviço de CEP indisponível." }); }
      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "CEP não encontrado. Confira os números digitados." });
      if (!result.inCity) throw new TRPCError({ code: "BAD_REQUEST", message: `Este CEP pertence a ${result.city || "outra cidade"}${result.state ? `-${result.state}` : ""}. O Conecta Barra atende apenas Barra do Piraí-RJ.` });
      return result;
    }),
  }),
  neighborhoods: router({
    list: publicProcedure.query(() => db.listNeighborhoods(true)),
    listAll: adminProcedure.query(() => db.listNeighborhoods(false)),
    add: adminProcedure.input(z.object({ name: z.string().min(2).max(120), area: z.string().min(2).max(60).default("Sede") })).mutation(async ({ input }) => { await db.upsertNeighborhood(input.name.trim(), input.area, "admin"); emit({ scopes: ["neighborhoods"], everyone: true }); return { success: true } as const; }),
    setActive: adminProcedure.input(z.object({ id: z.number().int().positive(), active: z.boolean() })).mutation(async ({ input }) => { await db.setNeighborhoodActive(input.id, input.active); emit({ scopes: ["neighborhoods"], everyone: true }); return { success: true } as const; }),
    /** Painel do bairro: números agregados e anônimos. */
    overview: protectedProcedure.input(z.object({ neighborhood: z.string().min(2).max(120).optional() }).optional()).query(async ({ ctx, input }) => {
      await ensureResidentProfileComplete(ctx.user);
      const own = ctx.user.role === "user" ? await db.getUserNeighborhood(ctx.user.id) : null;
      const target = input?.neighborhood ?? own;
      if (!target) throw new TRPCError({ code: "BAD_REQUEST", message: "Informe um bairro no seu perfil para ver o painel." });
      if (ctx.user.role === "user" && normalizeName(target) !== normalizeName(own)) throw new TRPCError({ code: "FORBIDDEN", message: "Você só pode ver o painel do seu bairro." });
      return db.getNeighborhoodOverview(target);
    }),
  }),
  portal: router({
    news: publicProcedure.query(() => fetchPortalNews()),
  }),
  backup: router({
    list: adminProcedure.query(() => db.listBackupSnapshots()),
    create: adminProcedure.input(z.object({ label: z.string().min(3).max(160) })).mutation(async ({ ctx, input }) => { const payload = await db.exportBackupData(); const serialized = JSON.stringify(payload); const checksum = createHash("sha256").update(serialized).digest("hex"); const id = await db.createBackupSnapshot({ createdBy: ctx.user.id, label: input.label, payload: serialized, checksum }); void recordAdminAction(ctx.user.id, { action: "backup_create", targetType: "backup", targetId: id, summary: `Backup ${id} criado.`, metadata: { checksum } }); return { id, checksum, createdAt: new Date() } as const; }),
    restore: adminProcedure.input(z.object({ id: z.number().int().positive(), confirmation: z.literal("RESTAURAR CONECTA") })).mutation(async ({ ctx, input }) => { const snapshot = await db.getBackupSnapshot(input.id); if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Backup não encontrado." }); let payload: Awaited<ReturnType<typeof db.exportBackupData>>; try { payload = JSON.parse(snapshot.payload) as Awaited<ReturnType<typeof db.exportBackupData>>; } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Backup inválido." }); } const checksum = createHash("sha256").update(snapshot.payload).digest("hex"); if (checksum !== snapshot.checksum) throw new TRPCError({ code: "BAD_REQUEST", message: "A integridade do backup não pôde ser confirmada." }); await db.restoreBackupData(payload); void recordAdminAction(ctx.user.id, { action: "backup_restore", targetType: "backup", targetId: snapshot.id, summary: `Backup ${snapshot.id} restaurado.`, metadata: { checksum } }); return { success: true } as const; }),
  }),
});

export type AppRouter = typeof appRouter;
