# Rodar online 24h no Oracle Cloud (Always Free)

Guia para hospedar o Validador de WhatsApp gratuitamente em uma VM do Oracle Cloud.

## 1. Criar a conta

1. Acesse <https://www.oracle.com/cloud/free/> e clique em "Start for free".
2. Preencha os dados. É pedido um cartão apenas para verificação — o plano Always Free **não cobra nada** enquanto você usar apenas recursos "Always Free".

## 2. Criar a VM (servidor)

1. No painel, vá em **Compute → Instances → Create instance**.
2. Nome: `validador-whatsapp`.
3. Em **Image and shape**:
   - Image: **Ubuntu 22.04** (Canonical Ubuntu).
   - Shape: **Ampere / VM.Standard.A1.Flex** — configure **2 OCPUs e 8 GB de RAM** (dentro do limite Always Free, que desde jun/2026 é 2 OCPUs / 12 GB no total).
4. Em **Add SSH keys**: escolha "Generate a key pair for me" e **baixe a chave privada** (guarde o arquivo `.key`).
5. Clique em **Create** e aguarde ficar "Running". Anote o **Public IP address**.

## 3. Liberar a porta 3000

1. Na página da instância, clique na **Virtual cloud network** → **Security Lists** → **Default Security List**.
2. **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: TCP
   - Destination Port Range: `3000`
3. Salve.

## 4. Conectar e instalar

Conecte via **Cloud Shell** (ícone `>_` no topo do painel) ou pelo terminal do Windows:

```bash
ssh -i caminho\para\sua-chave.key ubuntu@SEU_IP_PUBLICO
```

Depois cole os comandos abaixo, em blocos:

```bash
# Node.js 20 + Chromium + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo snap install chromium
```

```bash
# Projeto
git clone https://github.com/jackson499/ferramentas.git
cd ferramentas/validador-whatsapp
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

```bash
# Libera a porta 3000 no firewall interno da VM
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

```bash
# Inicia com PM2 (mantém rodando 24h e reinicia sozinho)
sudo npm install -g pm2
CHROME_PATH=/snap/bin/chromium HOST=0.0.0.0 SENHA_ACESSO=TroqueEstaSenha \
  pm2 start server.js --name validador
pm2 save
pm2 startup   # execute o comando que ele imprimir na tela
```

## 5. Usar

Acesse `http://SEU_IP_PUBLICO:3000`, digite a senha definida em `SENHA_ACESSO` e escaneie o QR Code. A sessão fica salva na VM — não pedirá QR novamente.

Comandos úteis na VM:

```bash
pm2 logs validador     # ver o log (QR gerado, conexões, erros)
pm2 restart validador  # reiniciar
```

## Avisos

- **Defina uma SENHA_ACESSO forte.** O endereço é público na internet; sem senha, qualquer pessoa que encontrar o IP pode escanear o QR e assumir seu WhatsApp.
- O IP de datacenter aumenta o risco de o WhatsApp desconfiar da sessão. Se a sessão cair com frequência, prefira rodar no seu PC.
- Para atualizar o código depois: `cd ~/ferramentas && git pull && pm2 restart validador`.
