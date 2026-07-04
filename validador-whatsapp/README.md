# Validador de WhatsApp

Ferramenta local para verificar se números de telefone possuem WhatsApp ativo antes do envio de campanhas, permitindo higienizar listas e reduzir desperdício de envios.

**O que esta ferramenta NÃO faz:** não envia mensagens, não automatiza disparos e não contorna mecanismos de segurança do WhatsApp. Ela apenas consulta se um número está registrado na plataforma, respeitando um intervalo entre consultas.

## Como funciona

1. O servidor Node.js abre uma sessão do WhatsApp Web via [whatsapp-web.js](https://wwebjs.dev/).
2. Você escaneia um QR Code (uma única vez — a sessão fica salva localmente).
3. Você envia um arquivo CSV/TXT com um número por linha e recebe o resultado: válido, inválido ou erro.
4. Ao final, é possível baixar um CSV com o status de cada número.

## Requisitos

- Node.js 18 ou superior
- Google Chrome/Chromium (baixado automaticamente pelo Puppeteer na instalação)
- Um número de WhatsApp ativo para autenticar a sessão

## Instalação

```bash
git clone https://github.com/jackson499/ferramentas.git
cd ferramentas/validador-whatsapp
npm install
```

## Uso

```bash
npm start
```

Abra `http://localhost:3000` no navegador, escaneie o QR Code com o WhatsApp (Aparelhos conectados → Conectar um aparelho) e envie sua lista.

### Senha de acesso (opcional)

Por padrão o painel abre sem senha (uso pessoal). Para exigir senha — recomendado se o link do túnel puder ser visto por outras pessoas:

```bash
# Windows (cmd)
set SENHA_ACESSO=SuaSenhaForte && npm start

# Windows (PowerShell)
$env:SENHA_ACESSO="SuaSenhaForte"; npm start

# Linux/macOS
SENHA_ACESSO=SuaSenhaForte npm start
```

## Acesso pela web (grátis, via túnel)

Para usar o painel de qualquer lugar sem pagar hospedagem, use o Cloudflare Tunnel — o servidor continua rodando no seu PC e um link público temporário é criado:

1. Baixe o `cloudflared` em <https://github.com/cloudflare/cloudflared/releases> (arquivo `cloudflared-windows-amd64.exe`).
2. Inicie o servidor (`npm start`).
3. Em outro terminal, rode:

```bash
cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
```

4. O terminal mostrará um link `https://xxxxx.trycloudflare.com` — acesse-o de qualquer dispositivo.

**Atenção:**

- O link só funciona enquanto o seu PC estiver ligado com o servidor e o túnel rodando, e muda a cada reinício do túnel (para link fixo, é preciso conta gratuita na Cloudflare com domínio próprio).
- **Não compartilhe o link do túnel**: quem acessar a tela do QR pode escanear e assumir sua conta do WhatsApp. Se o link puder vazar, defina `SENHA_ACESSO`.

Formato do arquivo (um número por linha, com DDI e DDD):

```
5511999998888
5521988887777
```

## Sessão e QR Code

- A sessão é salva na pasta `.wwebjs_auth/`. Nos próximos inícios do servidor, **não** será necessário escanear o QR novamente.
- Se o QR expirar antes de ser escaneado, um novo é gerado automaticamente (~a cada 30 segundos) e atualizado na tela.
- Se a autenticação falhar repetidamente, apague a pasta `.wwebjs_auth/` e escaneie novamente.
- **Nunca compartilhe nem versione a pasta `.wwebjs_auth/`** — ela contém as credenciais da sua sessão do WhatsApp.

## API

| Método | Rota           | Descrição                                              |
|--------|----------------|--------------------------------------------------------|
| GET    | `/api/status`  | Estado da conexão e imagem do QR Code (base64)         |
| POST   | `/api/validar` | Body: `{ "numero": "5511999998888" }` → `{ "valido": true }` |

O servidor escuta apenas em `127.0.0.1` (localhost) por segurança.

## Avisos importantes

- Este projeto usa a biblioteca **não oficial** `whatsapp-web.js`, que não é afiliada ao WhatsApp/Meta. O uso de clientes não oficiais pode violar os Termos de Serviço do WhatsApp e há risco de bloqueio do número utilizado. Use por sua conta e risco, preferencialmente com volume moderado.
- Utilize apenas listas de contatos obtidas com consentimento, em conformidade com a **LGPD**.
- Para validação oficial em escala, considere a [API do WhatsApp Business (Meta)](https://business.whatsapp.com/products/business-platform).

## Licença

MIT
