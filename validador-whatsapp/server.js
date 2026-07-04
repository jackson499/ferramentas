const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors());

// Serve o index.html direto do servidor (http://localhost:3000)
app.use(express.static(path.join(__dirname)));

let whatsappPronto = false;
let qrCodeBase64 = '';
let reconectando = false;

// ==========================================
// PROTEÇÃO POR SENHA (opcional)
// Sem SENHA_ACESSO definida, o painel abre direto — uso pessoal.
// Para exigir senha (recomendado se o link do túnel for compartilhado):
//   set SENHA_ACESSO=SuaSenhaForte && npm start
// ==========================================
const SENHA_ACESSO = process.env.SENHA_ACESSO || '';
if (!SENHA_ACESSO) {
    console.warn('Painel sem senha (SENHA_ACESSO não definida). Não compartilhe o link do túnel.');
}

app.use('/api', (req, res, next) => {
    if (!SENHA_ACESSO || req.headers['x-senha'] === SENHA_ACESSO) return next();
    res.status(401).json({ erro: 'Senha de acesso incorreta.' });
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Evento: gera o QR Code como imagem base64.
// A biblioteca emite um novo QR a cada ~30s enquanto não for escaneado,
// então este handler também cobre a renovação do QR expirado.
client.on('qr', async (qr) => {
    try {
        qrCodeBase64 = await qrcode.toDataURL(qr);
        console.log('QR Code gerado/atualizado. Abra http://localhost:3000 para escanear.');
    } catch (err) {
        console.error('Erro ao gerar imagem do QR Code:', err);
    }
});

client.on('authenticated', () => {
    console.log('Autenticado. Sessão salva em .wwebjs_auth/ (não precisará de QR no próximo início).');
});

client.on('ready', () => {
    whatsappPronto = true;
    qrCodeBase64 = ''; // Limpa a imagem, pois já conectou
    console.log('WhatsApp conectado e pronto para validar!');
});

client.on('auth_failure', (msg) => {
    whatsappPronto = false;
    qrCodeBase64 = '';
    console.error('Falha de autenticação:', msg);
    console.error('Se persistir, apague a pasta .wwebjs_auth/ e escaneie o QR novamente.');
});

// Evento: desconectado. Destrói a instância antes de reiniciar para
// evitar processos órfãos do Chromium e loop de reconexão.
client.on('disconnected', async (reason) => {
    whatsappPronto = false;
    qrCodeBase64 = '';
    console.warn('WhatsApp desconectado:', reason);

    if (reconectando) return;
    reconectando = true;
    try {
        await client.destroy();
    } catch (err) {
        console.error('Erro ao encerrar cliente:', err.message);
    }
    setTimeout(() => {
        reconectando = false;
        console.log('Tentando reconectar...');
        client.initialize().catch(err => console.error('Erro ao reinicializar:', err.message));
    }, 5000);
});

client.initialize().catch(err => console.error('Erro ao inicializar:', err.message));

// Encerramento limpo (handleSIGINT está desativado no puppeteer)
process.on('SIGINT', async () => {
    console.log('\nEncerrando...');
    try { await client.destroy(); } catch (_) { /* ignora */ }
    process.exit(0);
});

// Rota de status: o front-end consulta a cada 2 segundos
app.get('/api/status', (req, res) => {
    res.json({
        conectado: whatsappPronto,
        qrImage: qrCodeBase64
    });
});

// Rota de validação
app.post('/api/validar', async (req, res) => {
    if (!whatsappPronto) {
        return res.status(503).json({ erro: 'O WhatsApp não está conectado.' });
    }

    let { numero } = req.body;
    if (!numero || typeof numero !== 'string') {
        return res.status(400).json({ erro: 'Número não fornecido.' });
    }

    numero = numero.replace(/\D/g, '');

    // Valida o formato antes de consultar (evita chamadas inúteis à API)
    if (numero.length < 8 || numero.length > 15) {
        return res.status(400).json({ erro: 'Número em formato inválido.', valido: false });
    }

    const whatsappId = `${numero}@c.us`;

    try {
        const estaRegistrado = await client.isRegisteredUser(whatsappId);
        res.json({ valido: estaRegistrado });
    } catch (error) {
        console.error(`Erro ao consultar ${numero}:`, error.message);
        // 500 (e não 200) para o front-end distinguir "erro" de "número inválido"
        res.status(500).json({ erro: 'Erro interno ao consultar número.' });
    }
});

const PORT = process.env.PORT || 3000;
// Escuta apenas em localhost: impede que outras máquinas da rede usem a API
app.listen(PORT, '127.0.0.1', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
