const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const NUM_SESSOES = parseInt(process.env.NUM_SESSOES || '4', 10);
// Ritmo "equilibrado": cada número (sessão) espera entre 3s e 6s
// entre as próprias consultas. Com 4 sessões em paralelo, o total sai
// bem mais rápido, mas cada número continua consultando devagar.
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS || '3000', 10);
const MAX_INTERVAL_MS = parseInt(process.env.MAX_INTERVAL_MS || '6000', 10);

// Proteção por senha (opcional). Sem SENHA_ACESSO, o painel abre direto.
const SENHA_ACESSO = process.env.SENHA_ACESSO || '';
if (!SENHA_ACESSO) {
    console.warn('Painel sem senha (SENHA_ACESSO nao definida). Nao compartilhe o link.');
}
app.use('/api', (req, res, next) => {
    if (!SENHA_ACESSO || req.headers['x-senha'] === SENHA_ACESSO) return next();
    res.status(401).json({ erro: 'Senha de acesso incorreta.' });
});

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// SESSÕES
// ==========================================
const sessoes = [];

function criarSessao(indice) {
    const id = 'sessao-' + (indice + 1);
    const s = {
        id,
        indice,
        ready: false,
        qr: '',
        inUse: false,       // ocupada respondendo uma consulta agora
        busyUntil: 0,       // aguardando o intervalo antes da próxima consulta
        reconectando: false,
        client: null,
    };

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            handleSIGINT: false,
            executablePath: process.env.CHROME_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });
    s.client = client;

    client.on('qr', async (qr) => {
        try {
            s.qr = await qrcode.toDataURL(qr);
            console.log(`[${id}] QR gerado/atualizado.`);
        } catch (err) {
            console.error(`[${id}] Erro ao gerar QR:`, err.message);
        }
    });

    client.on('authenticated', () => {
        console.log(`[${id}] Autenticado. Sessao salva.`);
    });

    client.on('ready', () => {
        s.ready = true;
        s.qr = '';
        s.busyUntil = 0;
        console.log(`[${id}] Conectado e pronto!`);
    });

    client.on('auth_failure', (msg) => {
        s.ready = false;
        s.qr = '';
        console.error(`[${id}] Falha de autenticacao:`, msg);
    });

    client.on('disconnected', async (reason) => {
        s.ready = false;
        s.qr = '';
        console.warn(`[${id}] Desconectado:`, reason);
        if (s.reconectando) return;
        s.reconectando = true;
        try { await client.destroy(); } catch (err) { /* ignora */ }
        setTimeout(() => {
            s.reconectando = false;
            console.log(`[${id}] Reconectando...`);
            client.initialize().catch(err => console.error(`[${id}] Erro reinit:`, err.message));
        }, 5000);
    });

    return s;
}

// Cria e inicializa as sessões (com pequeno intervalo entre elas para
// não subir 4 navegadores exatamente no mesmo instante).
(async () => {
    for (let i = 0; i < NUM_SESSOES; i++) {
        const s = criarSessao(i);
        sessoes.push(s);
        s.client.initialize().catch(err => console.error(`[${s.id}] Erro ao inicializar:`, err.message));
        await sleep(1500);
    }
})();

// Encerramento limpo
process.on('SIGINT', async () => {
    console.log('\nEncerrando...');
    for (const s of sessoes) {
        try { await s.client.destroy(); } catch (_) { /* ignora */ }
    }
    process.exit(0);
});

// ==========================================
// SELEÇÃO DE SESSÃO (round-robin + intervalo por sessão)
// ==========================================
async function pegarSessao(timeoutMs = 120000) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
        if (!sessoes.some(s => s.ready)) {
            throw new Error('Nenhuma sessao conectada.');
        }
        const agora = Date.now();
        let escolhida = null;
        for (const s of sessoes) {
            if (s.ready && !s.inUse && agora >= s.busyUntil) {
                // pega a que está livre há mais tempo (menor busyUntil)
                if (!escolhida || s.busyUntil < escolhida.busyUntil) escolhida = s;
            }
        }
        if (escolhida) {
            escolhida.inUse = true;
            return escolhida;
        }
        await sleep(150);
    }
    throw new Error('Tempo esgotado aguardando uma sessao livre.');
}

function liberarSessao(s) {
    s.busyUntil = Date.now() + rand(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    s.inUse = false;
}

// ==========================================
// ROTAS
// ==========================================
app.get('/api/status', (req, res) => {
    const sessions = sessoes.map(s => ({
        id: s.id,
        conectado: s.ready,
        qrImage: s.ready ? '' : s.qr
    }));
    const conectados = sessoes.filter(s => s.ready).length;
    res.json({
        sessions,
        conectados,
        total: sessoes.length,
        algumConectado: conectados > 0,
        // compatibilidade com o painel antigo:
        conectado: conectados > 0,
        qrImage: (sessoes[0] && !sessoes[0].ready) ? sessoes[0].qr : ''
    });
});

app.post('/api/validar', async (req, res) => {
    let { numero } = req.body;
    if (!numero || typeof numero !== 'string') {
        return res.status(400).json({ erro: 'Numero nao fornecido.' });
    }
    numero = numero.replace(/\D/g, '');
    if (numero.length < 8 || numero.length > 15) {
        return res.status(400).json({ erro: 'Numero em formato invalido.', valido: false });
    }

    let s;
    try {
        s = await pegarSessao();
    } catch (e) {
        return res.status(503).json({ erro: e.message });
    }

    const whatsappId = `${numero}@c.us`;
    try {
        const registrado = await s.client.isRegisteredUser(whatsappId);
        liberarSessao(s);
        res.json({ valido: registrado, sessao: s.id });
    } catch (error) {
        liberarSessao(s);
        console.error(`[${s.id}] Erro ao consultar ${numero}:`, error.message);
        res.status(500).json({ erro: 'Erro interno ao consultar numero.' });
    }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT} com ${NUM_SESSOES} sessoes.`);
});
