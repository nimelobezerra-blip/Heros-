# HEROS — versão independente

O mesmo site de controlo de horas da app no Claude, mas abre num endereço próprio, sem conta Claude.

- **Entrada:** botão "Entrar com Google", com a opção **Manter sessão iniciada**. Ligada, o site lembra a entrada durante 180 dias; desligada, a sessão termina ao fechar o navegador.
- **Dados:** as horas, os dados da fatura e as etiquetas ficam num ficheiro privado, numa pasta do seu Google Drive que só esta app vê (não aparece na lista normal de ficheiros do Drive).
- **Agenda:** vem do seu Google Calendar.

## 1. Criar o ID de cliente Google (uma vez, grátis)

1. Abra <https://console.cloud.google.com> e crie um projeto chamado **Bezerra**.
2. Em **APIs e serviços → Biblioteca**, ative a **Google Calendar API** e a **Google Drive API**.
3. Em **APIs e serviços → Ecrã de consentimento OAuth**:
   - escolha **Externo**;
   - dê o nome **Bezerra** e o seu email;
   - em **Utilizadores de teste**, adicione o seu email Google.
4. Em **APIs e serviços → Credenciais → Criar credenciais → ID de cliente OAuth**:
   - escolha o tipo **Aplicação Web**;
   - em **Origens JavaScript autorizadas**, adicione o endereço do site, por exemplo `https://SEU-UTILIZADOR.github.io`;
   - se mais tarde ligar um domínio próprio, adicione-o também aqui (ex.: `https://bezerrahoras.pt`).
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e cole-o em `config.js`:

   ```js
   window.BEZERRA_CONFIG = {
     googleClientId: "123456-abc.apps.googleusercontent.com",
   };
   ```

Este ID não é secreto e pode ficar público no site.

Enquanto a app estiver em modo de teste, o Google mostra o aviso "app não verificada" ao entrar. Escolha **Continuar**. Só os emails que adicionou como utilizadores de teste conseguem entrar.

## 2. Pôr o site no ar com GitHub Pages

1. Crie um repositório no GitHub (ex.: `bezerra`) e envie para lá todos os ficheiros desta pasta.
2. No repositório, vá a **Settings → Pages**, escolha **Deploy from a branch**, depois o ramo `main` e a pasta `/ (root)`, e guarde.
3. Ao fim de um ou dois minutos, o site fica em `https://SEU-UTILIZADOR.github.io/bezerra/`.

Para usar um domínio próprio, defina-o em **Settings → Pages → Custom domain** e siga as instruções de DNS do GitHub.

## Endereço no Cloudflare

O site também está publicado no Cloudflare, ligado a este repositório (cada envio para `main` publica a versão nova):

**https://heros.nimelobezerra.workers.dev/**

Este endereço tem de estar nas **Origens JavaScript autorizadas** do ID de cliente Google (ver passo 1), sem barra no fim: `https://heros.nimelobezerra.workers.dev`.

A configuração está em `wrangler.jsonc`; `.assetsignore` impede que `src/`, `build.py` e outros ficheiros do repositório fiquem públicos.

## Manter sessão iniciada (Cloudflare)

`worker.js` guarda a sessão Google num cookie cifrado (HttpOnly) e renova o acesso sozinho, sem janelas nem toques: 180 dias com «Manter sessão iniciada», ou até fechar o navegador sem essa opção.

**Atenção:** enquanto a app estiver em modo de teste no Google Cloud, o Google corta a sessão ao fim de 7 dias. Para durar mais, em **Ecrã de consentimento OAuth** carregue em **Publicar app** (fica em produção; o aviso «app não verificada» continua a aparecer ao entrar, basta escolher Continuar). Para funcionar, o Worker precisa do **Client secret** do Google como segredo:

1. Google Cloud Console → **APIs e serviços → Credenciais** → o seu ID de cliente OAuth → copie o **Segredo do cliente** (Client secret).
2. Cloudflare → **Workers e Pages** → **heros** → **Definições** → **Variáveis e segredos** → **Adicionar** → tipo **Segredo**, nome `GOOGLE_CLIENT_SECRET`, valor: o segredo copiado → **Implementar**.

O segredo fica só no Cloudflare: nunca o ponha no repositório nem o envie a ninguém. Sem ele, o site funciona como antes (pede um toque no ecrã de hora a hora).

## 3. No iPhone

1. Abra o endereço do site no **Safari**.
2. Toque em **Partilhar → Adicionar ao ecrã principal**.

O site fica no ecrã principal com o ícone HEROS e abre em ecrã inteiro, como uma app.

## Atualizar o site

`src/app.html` é a mesma página da app no Claude. Depois de a alterar, corra `python3 build.py` para gerar `index.html` de novo.

## Ficheiros

| Ficheiro | Para que serve |
|---|---|
| `index.html` | O site (gerado por `build.py`) |
| `standalone.js` | Ligação ao Google: login, Drive, Calendar e downloads |
| `config.js` | O seu ID de cliente Google |
| `manifest.webmanifest`, `icons/` | Ícone e instalação no ecrã principal |
| `src/app.html` | Página original da app |
| `build.py` | Gera `index.html` a partir de `src/app.html` |

## Dados separados do NICO

O HEROS usa o mesmo ID de cliente Google do NICO, mas guarda as horas noutro ficheiro (`heros-dados.json`), por isso os registos dos dois sites não se misturam.
