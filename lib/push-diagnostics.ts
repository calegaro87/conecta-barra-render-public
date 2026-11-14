/**
 * Traduz os códigos de erro devolvidos pelo Expo Push Service em uma orientação
 * objetiva para o administrador (usado nos alertas do push de teste).
 */
export function describePushErrors(errors?: string[] | null): string {
  const list = errors ?? [];
  if (list.length === 0) return "";
  const hints = new Set<string>();
  for (const code of list) {
    switch (code) {
      case "InvalidCredentials":
        hints.add("O Expo rejeitou a credencial FCM V1 do Android (InvalidCredentials). No projeto EAS correto, substitua a chave de conta de serviço em Credentials → Android → FCM V1 e gere um novo APK.");
        break;
      case "MismatchSenderId":
        hints.add("O Firebase recusou o envio por divergência de projeto (MismatchSenderId). A chave FCM V1 (conta de serviço) cadastrada no EAS e o google-services.json do APK precisam ser do MESMO projeto Firebase (veja project_id no google-services.json). Gere uma nova chave nesse projeto, cadastre no EAS (Credentials → Android → FCM V1) e gere um novo APK.");
        break;
      case "DeviceNotRegistered":
        hints.add("O token do aparelho não é mais válido. Abra o app, faça login novamente e repita o teste.");
        break;
      case "MessageRateExceeded":
        hints.add("O Expo limitou o envio temporariamente. Aguarde alguns minutos.");
        break;
      case "MessageTooBig":
        hints.add("A mensagem excedeu o tamanho permitido pelo serviço.");
        break;
      case "NetworkError":
        hints.add("O servidor não conseguiu alcançar o serviço de notificações do Expo.");
        break;
      default:
        hints.add(`Código retornado pelo Expo: ${code}.`);
    }
  }
  return [...hints].join(" ");
}
