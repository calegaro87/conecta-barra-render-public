import tls from "node:tls";
import { createHash } from "node:crypto";
import * as db from "./db";

// Em produção no Render Free, use a API HTTPS da Brevo; SMTP permanece como fallback para outros ambientes.
const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL?.trim() ?? "";
const BREVO_API_KEY = process.env.BREVO_API_KEY?.trim() ?? "";
const SMTP_HOST = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);

export type RegistrationEmailDetails = {
  name: string;
  username: string;
  email: string;
  address: string;
  phone: string;
  sex: string;
};

type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

type EmailDeliveryMeta = {
  purpose: "verification" | "admin_registration" | "password_reset";
  userId?: number;
  provider?: "smtp" | "brevo";
};

function hashRecipient(recipient: string) {
  return createHash("sha256").update(recipient.trim().toLowerCase()).digest("hex");
}

async function recordEmailDelivery(meta: EmailDeliveryMeta, recipient: string, status: "sent" | "failed", startedAt: number, error?: unknown) {
  await db.createEmailDeliveryLog({
    userId: meta.userId ?? null,
    purpose: meta.purpose,
    recipientHash: hashRecipient(recipient),
    status,
    provider: meta.provider ?? "smtp",
    errorCode: status === "failed" ? (error instanceof Error ? error.message.match(/(?:Gmail SMTP|Brevo API) (\d{3})/)?.[1] ?? (meta.provider === "brevo" ? "BREVO_ERROR" : "SMTP_ERROR") : "EMAIL_ERROR") : null,
    errorMessage: status === "failed" ? (error instanceof Error ? error.message.slice(0, 240) : "Falha desconhecida") : null,
    durationMs: Math.max(0, Date.now() - startedAt),
  }).catch((logError: unknown) => console.warn("[Email] Could not persist delivery log:", logError));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function encodeMimeHeader(value: string) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encodeMimeBody(value: string) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function validateEmail(value: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /[\r\n]/.test(value)) throw new Error("Endereço de e-mail inválido.");
  return value;
}

function getGmailConfig() {
  const sender = process.env.GMAIL_SENDER_EMAIL?.trim();
  const appPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!sender || !appPassword) throw new Error("GMAIL_SENDER_EMAIL (e-mail remetente) ou GMAIL_APP_PASSWORD (senha de app/SMTP) não configurado.");
  return { sender: validateEmail(sender), appPassword };
}

function readReply(socket: tls.TLSSocket) {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("Tempo esgotado aguardando resposta do Gmail."));
    }, 15_000);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) ?? "";
      if (/^\d{3} /.test(last)) {
        clearTimeout(timeout);
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", (error) => { clearTimeout(timeout); socket.off("data", onData); reject(error); });
  });
}

async function smtpCommand(socket: tls.TLSSocket, command: string, expectedCodes: number[]) {
  socket.write(`${command}\r\n`);
  const reply = await readReply(socket);
  const code = Number(reply.slice(0, 3));
  if (!expectedCodes.includes(code)) throw new Error(`Gmail SMTP ${code}: ${reply.replace(/\r?\n/g, " ").slice(0, 240)}`);
  return reply;
}

function buildMimeMessage(message: EmailMessage, sender: string) {
  const boundary = `conecta_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return [
    `From: Conecta Barra <${sender}>`,
    `To: ${message.to}`,
    `Subject: ${encodeMimeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeMimeBody(message.html),
    `--${boundary}--`,
  ].join("\r\n");
}

async function sendGmailEmail(message: EmailMessage, meta: EmailDeliveryMeta) {
  const startedAt = Date.now();
  const { sender, appPassword } = getGmailConfig();
  const recipient = validateEmail(message.to);
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    await readReply(socket);
    await smtpCommand(socket, "EHLO conectabarra", [250]);
    await smtpCommand(socket, "AUTH LOGIN", [334]);
    await smtpCommand(socket, Buffer.from(sender, "utf8").toString("base64"), [334]);
    await smtpCommand(socket, Buffer.from(appPassword, "utf8").toString("base64"), [235]);
    await smtpCommand(socket, `MAIL FROM:<${sender}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    await smtpCommand(socket, "DATA", [354]);
    socket.write(`${buildMimeMessage(message, sender).replace(/\n/g, "\r\n")}\r\n.\r\n`);
    await readReply(socket);
    await smtpCommand(socket, "QUIT", [221, 250]);
    await recordEmailDelivery(meta, recipient, "sent", startedAt);
    return { sender, recipient };
  } catch (error) {
    await recordEmailDelivery(meta, recipient, "failed", startedAt, error);
    throw error;
  } finally {
    socket.destroy();
  }
}

async function sendBrevoEmail(message: EmailMessage, meta: EmailDeliveryMeta) {
  const startedAt = Date.now();
  const recipient = validateEmail(message.to);
  const sender = (process.env.BREVO_SENDER_EMAIL ?? process.env.GMAIL_SENDER_EMAIL ?? "").trim();
  const deliveryMeta = { ...meta, provider: "brevo" as const };
  try {
    if (!BREVO_API_KEY) throw new Error("BREVO_API_KEY não configurada.");
    if (!sender) throw new Error("BREVO_SENDER_EMAIL não configurado.");
    validateEmail(sender);
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Conecta Barra", email: sender },
        to: [{ email: recipient }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
    });
    if (!response.ok) {
      const details = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
      throw new Error(`Brevo API ${response.status}: ${details || "Falha ao enviar e-mail."}`);
    }
    await recordEmailDelivery(deliveryMeta, recipient, "sent", startedAt);
    return { sender, recipient };
  } catch (error) {
    await recordEmailDelivery(deliveryMeta, recipient, "failed", startedAt, error);
    throw error;
  }
}

function sendEmail(message: EmailMessage, meta: EmailDeliveryMeta) {
  return BREVO_API_KEY ? sendBrevoEmail(message, meta) : sendGmailEmail(message, meta);
}

export function buildVerificationEmail(input: { name: string; email: string; code: string }): EmailMessage {
  const name = escapeHtml(input.name);
  const code = escapeHtml(input.code);
  return {
    to: validateEmail(input.email),
    subject: "Código de confirmação do cadastro — Conecta Barra",
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#17324d"><h2>Confirme seu cadastro no Conecta Barra</h2><p>Olá, ${name}.</p><p>Use o código abaixo para confirmar o endereço de e-mail informado no cadastro:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px;color:#0877c9">${code}</p><p>O código expira em 10 minutos e pode ser usado uma única vez.</p><p>Se você não iniciou este cadastro, ignore esta mensagem.</p></div>`,
    text: `Confirme seu cadastro no Conecta Barra\n\nOlá, ${input.name}.\n\nSeu código de confirmação é: ${input.code}\n\nEle expira em 10 minutos e pode ser usado uma única vez. Se você não iniciou este cadastro, ignore esta mensagem.`,
  };
}

export function buildNewRegistrationAdminEmail(input: RegistrationEmailDetails): EmailMessage {
  const rows = [
    ["Nome completo", input.name],
    ["Usuário", input.username],
    ["E-mail", input.email],
    ["Endereço", input.address],
    ["Telefone", input.phone],
    ["Sexo informado", input.sex],
  ] as const;
  const htmlRows = rows.map(([label, value]) => `<tr><td style="padding:8px;font-weight:700;border-bottom:1px solid #dde6ef">${escapeHtml(label)}</td><td style="padding:8px;border-bottom:1px solid #dde6ef">${escapeHtml(value)}</td></tr>`).join("");
  const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  return {
    to: ADMIN_NOTIFICATION_EMAIL || "nao-configurado@invalid.local",
    subject: `Novo cadastro confirmado — ${input.name}`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#17324d"><h2>Novo morador confirmou o cadastro</h2><p>O e-mail do novo usuário foi validado. O cadastro segue aguardando aprovação da gestão.</p><table style="border-collapse:collapse;width:100%;max-width:680px">${htmlRows}</table><p style="margin-top:16px">A senha e o código de verificação não são enviados nem armazenados nesta mensagem.</p></div>`,
    text: `Novo morador confirmou o cadastro\n\nO e-mail do novo usuário foi validado. O cadastro segue aguardando aprovação da gestão.\n\n${text}\n\nA senha e o código de verificação não são enviados nesta mensagem.`,
  };
}

export async function sendVerificationEmail(input: { name: string; email: string; code: string; userId?: number }) {
  return sendEmail(buildVerificationEmail(input), { purpose: "verification", userId: input.userId });
}

export function buildPasswordResetEmail(input: { name: string; email: string; code: string }): EmailMessage {
  return {
    to: validateEmail(input.email),
    subject: "Código para redefinir sua senha — Conecta Barra",
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#17324d"><h2>Redefinição de senha Conecta Barra</h2><p>Olá, ${escapeHtml(input.name)}.</p><p>Use o código abaixo para escolher uma nova senha:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px;color:#0877c9">${escapeHtml(input.code)}</p><p>O código expira em 10 minutos e pode ser usado uma única vez. Se você não solicitou a redefinição, ignore esta mensagem.</p></div>`,
    text: `Redefinição de senha Conecta Barra\n\nOlá, ${input.name}.\n\nSeu código para redefinir a senha é: ${input.code}\n\nEle expira em 10 minutos e pode ser usado uma única vez. Se você não solicitou a redefinição, ignore esta mensagem.`,
  };
}

export async function sendNewRegistrationAdminEmail(input: RegistrationEmailDetails & { userId?: number }) {
  if (!ADMIN_NOTIFICATION_EMAIL) throw new Error("ADMIN_NOTIFICATION_EMAIL não configurado.");
  return sendEmail(buildNewRegistrationAdminEmail(input), { purpose: "admin_registration", userId: input.userId });
}

export async function sendPasswordResetEmail(input: { name: string; email: string; code: string; userId?: number }) {
  return sendEmail(buildPasswordResetEmail(input), { purpose: "password_reset", userId: input.userId });
}

export { ADMIN_NOTIFICATION_EMAIL };
