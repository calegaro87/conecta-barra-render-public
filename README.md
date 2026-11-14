# Conecta Barra

Aplicativo Android (Expo / React Native) + backend (Node, tRPC, MySQL, WebSocket) para moradores de
**Barra do Piraí-RJ**: solicitações de reparo por bairro, comunicados da Prefeitura, sugestões,
notificações push reais, atualização em tempo real entre aparelhos e redes, login com biometria e
integração com os canais oficiais da Prefeitura.

Baseado no código do app anterior (todas as funções foram mantidas e adaptadas), sem nenhuma dependência da plataforma Manus.

## O que mudou em relação ao app anterior

| Área | Conecta Barra |
|---|---|
| Nome / marca | Conecta Barra; logotipo e splash azul → azul claro **gerados na compilação** (`scripts/generate-brand-assets.mjs`) |
| Bairros | Moradores, solicitações, sugestões e comunicados são filtrados por **bairro**. Lista editável no painel (Gerenciar bairros) |
| Endereço | **CEP automático** (ViaCEP com fallback BrasilAPI, via servidor). Só aceita CEP de Barra do Piraí-RJ (IBGE 3300308) |
| Tempo real | **WebSocket** (`/ws`): qualquer mudança aparece em todos os aparelhos, em qualquer rede, em ~1 s. Reconecta sozinho ao trocar Wi-Fi ↔ 4G |
| Push | Expo Push + FCM, canal Android `conecta-alerts`, segmentado por bairro, tokens inválidos limpos automaticamente |
| Navegação | Barra inferior flutuante com pílula animada: Início · Pedidos · Prefeitura · Avisos · Conta |
| Login | Tela nova, **biometria** (digital/rosto) para entrar e **bloqueio do app** opcional (Conta → Bloqueio por biometria) |
| Canais oficiais | Aba **Prefeitura**: notícias lidas do portal, serviços (Ouvidoria, Transparência, Carta de Serviços…), Instagram, Facebook, YouTube, telefones |
| Novidades do tema | **Painel do Bairro** (números anônimos em tempo real), **Alerta da Defesa Civil**, protocolo `CB-2026-000123`, novas categorias (lixo, bueiro, árvore, área de risco) |
| Atualizações | **EAS Update (OTA)** com aviso "Reiniciar agora" dentro do app |
| Assinatura | Keystore de release gerenciada pelo EAS (ou local) — veja seção 5 |

## 1. Pré-requisitos

- Node 20+ e npm; conta gratuita em https://expo.dev; `npm i -g eas-cli`
- Projeto Firebase com o app Android `com.conectabarra.app`; `google-services.json` fica na raiz e é usado na build EAS.
- Para o Blueprint Render, o código precisa estar em repositório GitHub/GitLab. Use repositório privado e nunca suba `.env`, senhas, nem a chave privada de serviço FCM.

## 2. Backend gratuito (Render + TiDB Cloud Starter)

O `render.yaml` descreve o serviço Node no plano Free e configura TLS para o TiDB. A API já está publicada em **https://conecta-barra-api.onrender.com**. O esquema Drizzle já foi aplicado no banco TiDB Cloud Starter usando TLS; as credenciais do banco e do administrador permanecem em variáveis protegidas do Render, fora do Git.

Em 12/11/2026, `GET /api/health` respondeu HTTP 200. A consulta pública do CEP `27123-080` também respondeu HTTP 200 e retornou Barra do Piraí-RJ via ViaCEP; o backend usa BrasilAPI como fallback. O WebSocket é servido em `/ws` no mesmo domínio seguro.

As fotos de perfil e solicitações são gravadas na tabela `media_assets` do TiDB, não no disco efêmero do Render. O servidor limita cada imagem a **3 MiB**. O código de persistência está implementado, mas ainda falta validar um upload autenticado de ponta a ponta no app.

**Para tempo real e push realmente contínuos, o plano Free do Render NÃO serve**: ele hiberna após ~15 min sem requisições, derruba todos os WebSockets e o primeiro aviso depois disso falha ou atrasa. O `render.yaml` agora usa `plan: starter` (sempre ligado) com `numInstances: 1` (os eventos de tempo real ficam na memória do processo). Veja `INSTRUCOES-CORRECOES.txt`.

### Monitoramento com UptimeRobot

O monitor ainda depende de autenticação na conta UptimeRobot. Configure um monitor HTTP(S) para `https://conecta-barra-api.onrender.com/api/health`. Uma verificação periódica pode reduzir a hibernação, mas não elimina reinícios nem transforma o Render Free em hospedagem com disponibilidade garantida; use-o para hobby/teste ou piloto.

### Alternativa: servidor próprio com Docker

```bash
cp .env.example .env          # defina JWT_SECRET com `openssl rand -hex 32`
docker compose up -d --build  # MySQL + API + HTTPS automático (Caddy)
docker compose run --rm api npm run db:push
curl https://api.seu-dominio.com.br/api/health
```

Os bairros iniciais são criados automaticamente na primeira inicialização. Fotos também ficam no MySQL. O Caddy serve HTTPS/WSS. Desenvolvimento local: `npm install && npm run dev:server`.

## 3. Push real (Firebase / FCM) — obrigatório para notificações

O projeto Firebase `conecta-barra-c2648` contém o app Android `com.conectabarra.app`; `google-services.json` é a configuração pública do app e permanece na raiz do projeto. A conta dedicada `conecta-barra-fcm-sender` recebeu o papel específico **Firebase Cloud Messaging API Admin**.

A chave privada JSON foi enviada diretamente às credenciais EAS e atribuída a **Push Notifications (FCM V1)** para o pacote Android. O arquivo local foi apagado depois da confirmação do upload e não deve ser versionado. Não foi configurada a API FCM legada.

Isso confirma a configuração no EAS, mas ainda não comprova o envio até um aparelho. O app solicita permissão e registra um Expo Push Token; o teste de ponta a ponta exige instalar o APK, permitir notificações, entrar com uma conta e usar **Segurança → Enviar push de teste** no painel. No código do backend, `EXPO_ACCESS_TOKEN` é opcional e só é enviado quando o projeto Expo exige “Enhanced Security for Push Notifications”.

## 4. Compilar o APK / AAB (Android)

```bash
npm install                    # gera o logotipo e a splash automaticamente (postinstall)
npm run check
eas login                      # se a CLI não estiver autenticada
EXPO_PUBLIC_EAS_PROJECT_ID=0dabf554-1a7c-44a9-9212-7ed648cd58b3 EXPO_PUBLIC_API_URL=https://conecta-barra-api.onrender.com npx --yes eas-cli@latest build --platform android --profile preview
# Para Google Play, usar o perfil production e revisar a assinatura antes de enviar.
```

O perfil `preview` gera um APK instalável e usa a URL real do backend. A build solicitada em 12/11/2026 está em processamento no EAS; este README não considera o APK pronto até a plataforma confirmar sucesso e disponibilizar o artefato.

Compilação local (sem EAS; exige JDK 17 + Android SDK):

```bash
npm run build:apk:local        # gera android/app/build/outputs/apk/release/app-release.apk
```

**Logotipo na compilação:** `npm install`/`npm run assets` executa `scripts/generate-brand-assets.mjs`, que cria
ícone, ícone adaptativo/monocromático, splash (azul → azul claro), ícone de notificação e favicon. Sem
dependências externas; roda também no EAS.

**Logotipo da Prefeitura (2026):** o arquivo oficial não pôde ser baixado automaticamente. Copie o logotipo
atualizado (PNG com fundo transparente, ≥ 512 px) para `assets/brand/prefeitura-logo.png`. O gerador **nunca
sobrescreve** esse arquivo; enquanto ele não existir, é usado um marcador genérico. O logotipo aparece na
splash, no login, no Início e na aba Prefeitura (componente `PrefeituraBadge`).

## 5. Assinatura do aplicativo

- **EAS (recomendado):** a primeira build Android criou uma keystore JKS na conta Expo. Um backup JKS foi baixado para armazenamento privado fora do repositório; a senha não foi exibida no terminal nem enviada ao Git. Perder a keystore impede atualizar a mesma aplicação na Play Store.
- **Local:** `keytool -genkeypair -v -storetype PKCS12 -keystore conectabarra.jks -alias conectabarra -keyalg RSA -keysize 2048 -validity 10000`
  e configure em `android/app/build.gradle` (signingConfigs). Nunca versione o `.jks`.
- **Google Play:** ative *Play App Signing* ao enviar o primeiro AAB (`eas submit -p android`).

## 6. Atualizações reais (OTA)

Mudanças só de JavaScript/telas/textos não precisam de nova build:

```bash
npm run update:ota -- "Corrige tela de solicitações"
```

O app baixa a atualização ao abrir/voltar e mostra "Nova versão pronta — Reiniciar agora".
Mudanças em módulos nativos, permissões ou `app.config.ts` exigem nova build (e aumento de `version`).

## 7. Como funciona o tempo real

`lib/realtime.ts` abre `wss://API/ws` com o token da sessão. Depois de cada ação (novo pedido, mudança de status,
comunicado, aprovação de morador…), o servidor (`server/realtime.ts`) envia ao app apenas *quais dados mudaram*
e o app recarrega só essas consultas. Moradores recebem eventos do próprio bairro; gestores recebem tudo.
Há ping a cada 25 s, reconexão com backoff e reconexão imediata ao trocar de rede. Se o WebSocket cair, o app
continua atualizando por consulta periódica (30–60 s) e o push avisa de qualquer forma.
Com **mais de uma instância** da API, troque o hub em memória por Redis pub/sub.

## 8. Integração com os portais oficiais

`shared/official.ts` reúne os endereços oficiais (conferidos no portal em 11/11/2026): portal
`barradopirai.rj.gov.br`, Instagram `@pmbpoficial`, Facebook `pmbpoficial`, YouTube, contatos e atalhos de serviços.
`server/portal.ts` lê as últimas notícias da página inicial do portal (cache de 10 min). O portal **não oferece
API/RSS público**; se o layout mudar, a lista fica vazia e o app mostra o botão "Abrir notícias no portal".
O **WhatsApp** oficial não consta no rodapé do portal: informe em `OFFICIAL_WHATSAPP_URL` ou no painel
(Canais oficiais). Os links também podem ser editados pelo gestor.

## 9. Estrutura

```
app/            telas (expo-router)      app/(tabs)/ → Início, Pedidos, Prefeitura, Avisos, Conta
components/     UI: tab bar flutuante, CEP, biometria, tempo real, atualização OTA
server/         API tRPC, WebSocket, push, CEP, portal, e-mail, banco (Drizzle/MySQL)
shared/         bairros, categorias, canais oficiais (usado por app e servidor)
scripts/        geração de logotipo/splash
deploy/         Caddyfile e package do servidor
```

## 10. Limitações conhecidas (leia antes de publicar)

- A biometria de login e o bloqueio do app estão implementados com `expo-local-authentication` e armazenamento seguro. Ainda precisam de validação em um Android real com biometria configurada; inspeção de código ou Expo Go não confirma o comportamento nativo.
- A credencial FCM V1 está configurada no EAS, mas a notificação de ponta a ponta ainda depende do teste com um aparelho instalado e autenticado.
- Fotos persistem no TiDB pelo caminho implementado no servidor; falta validar um upload autenticado em produção.
- A autenticação do WebSocket está no código, mas o fluxo de uma sessão real aprovada ainda não foi validado em produção. O hub de eventos é em memória; múltiplas instâncias exigiriam Redis pub/sub.
- O Render Free é para hobby/teste, pode hibernar e não oferece SLA. A API pode ficar lenta no primeiro acesso depois de inatividade.
- `npm run check` passou antes da build; repita após alterações futuras de código.
- A lista de bairros é uma semente baseada em cadastros públicos de CEP; confirme com a Prefeitura.
- A leitura de notícias depende do HTML atual do portal.
- Login do gestor é único (variáveis de ambiente). Gestores por secretaria/bairro não foram implementados.
- Publicar como "app oficial da Prefeitura" exige autorização formal e uso autorizado do brasão/logotipo.

## Se o app compilado ainda aparecer com a marca antiga

Isso vem de pastas geradas por uma compilação anterior, não do código. Antes de compilar:

```bash
rm -rf android ios .expo node_modules/.cache
npm install && npm run assets
npx expo prebuild --platform android --clean
```

No EAS use `eas build --clear-cache`. O pacote agora é `com.conectabarra.app`; desinstale versões antigas do aparelho.
