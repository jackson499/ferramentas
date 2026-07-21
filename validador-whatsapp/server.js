const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const { exec, spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const NUM_SESSOES = parseInt(process.env.NUM_SESSOES || '4', 10);
// Ritmo "equilibrado": cada número (sessão) espera entre 3s e 6s
// entre as próprias consultas. Com 4 sessões em paralelo, o total
// sai mais rápido, mas cada número consulta devagar.
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

// Mata a janela do Chrome/WhatsApp Web presa de UMA sessao (nao mexe no Chrome de navegacao).
function matarChromeDaSessao(id) {
    const filtro = 'session-' + id; // ex.: user-data-dir .../.wwebjs_auth/session-sessao-1
    const cmd = `Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${filtro}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { exec('powershell -NoProfile -Command "' + cmd + '"', () => {}); } catch (_) { /* ignora */ }
}

// Remove travas de sessao que impedem o Chrome de reabrir aquele numero.
function limparLock(id) {
    const dir = path.join(__dirname, '.wwebjs_auth', 'session-' + id);
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignora */ }
    });
}

// ==========================================
// SESSÕES
// ==========================================
const sessoes = [];

// Cria (ou recria) o Client de uma sessão e liga os eventos.
function montarClient(s) {
    const id = s.id;
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            handleSIGINT: false,
            executablePath: process.env.CHROME_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        try {
            s.qr = await qrcode.toDataURL(qr);
            console.log(`[${id}] QR gerado/atualizado.`);
        } catch (err) {
            console.error(`[${id}] Erro ao gerar QR:`, err.message);
        }
    });

    client.on('authenticated', () => console.log(`[${id}] Autenticado. Sessao salva.`));

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
        // Se foi desconexão manual, o handler de /api/desconectar cuida da recriação.
        if (s.desconectandoManual || s.reconectando) return;
        s.reconectando = true;
        try { await client.destroy(); } catch (err) { /* ignora */ }
        setTimeout(() => {
            s.reconectando = false;
            console.log(`[${id}] Reconectando...`);
            recriarClient(s);
        }, 5000);
    });

    s.client = client;
    return client;
}

function recriarClient(s) {
    montarClient(s);
    s.client.initialize().catch(err => console.error(`[${s.id}] Erro ao inicializar:`, err.message));
}

function criarSessao(indice) {
    const s = {
        id: 'sessao-' + (indice + 1),
        indice,
        ready: false,
        qr: '',
        inUse: false,
        busyUntil: 0,
        reconectando: false,
        desconectandoManual: false,
        client: null,
    };
    montarClient(s);
    return s;
}

// Sobe as sessões com pequeno intervalo entre elas.
(async () => {
    for (let i = 0; i < NUM_SESSOES; i++) {
        const s = criarSessao(i);
        sessoes.push(s);
        s.client.initialize().catch(err => console.error(`[${s.id}] Erro ao inicializar:`, err.message));
        await sleep(1500);
    }
})();

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
        if (!sessoes.some(s => s.ready)) throw new Error('Nenhuma sessao conectada.');
        const agora = Date.now();
        let escolhida = null;
        for (const s of sessoes) {
            if (s.ready && !s.inUse && agora >= s.busyUntil) {
                if (!escolhida || s.busyUntil < escolhida.busyUntil) escolhida = s;
            }
        }
        if (escolhida) { escolhida.inUse = true; return escolhida; }
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
    try { s = await pegarSessao(); }
    catch (e) { return res.status(503).json({ erro: e.message }); }

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

// Desconecta (desloga) um número. Ele volta a exibir o QR para você
// conectar outro WhatsApp naquele espaço.
app.post('/api/desconectar', async (req, res) => {
    const { sessao } = req.body || {};
    const s = sessoes.find(x => x.id === sessao);
    if (!s) return res.status(404).json({ erro: 'Sessao nao encontrada.' });

    s.desconectandoManual = true;
    s.ready = false;
    s.qr = '';
    try {
        try { await s.client.logout(); } catch (e) { console.warn(`[${s.id}] logout:`, e.message); }
        try { await s.client.destroy(); } catch (e) { /* ignora */ }
        // Recria o client para gerar um novo QR
        setTimeout(() => {
            s.desconectandoManual = false;
            console.log(`[${s.id}] Desconectado manualmente. Gerando novo QR...`);
            recriarClient(s);
        }, 1500);
        res.json({ ok: true, sessao: s.id });
    } catch (e) {
        s.desconectandoManual = false;
        console.error(`[${s.id}] Erro ao desconectar:`, e.message);
        res.status(500).json({ erro: 'Erro ao desconectar.' });
    }
});

// Gera um QR Code novo na hora (reinicia só aquela sessão, se ainda não conectou).
app.post('/api/atualizar-qr', async (req, res) => {
    const { sessao } = req.body || {};
    const s = sessoes.find(x => x.id === sessao);
    if (!s) return res.status(404).json({ erro: 'Sessao nao encontrada.' });
    if (s.ready) return res.json({ ok: true, jaConectado: true });

    s.reconectando = true;   // evita que o handler 'disconnected' recrie em paralelo
    s.qr = '';
    // destroy pode travar se o Chrome congelou; nao esperamos alem de 4s.
    try { await Promise.race([s.client.destroy(), sleep(4000)]); } catch (e) { /* ignora */ }
    // Mata a janela travada do Chrome dessa sessao e limpa as travas.
    matarChromeDaSessao(s.id);
    limparLock(s.id);
    setTimeout(() => {
        s.reconectando = false;
        console.log(`[${s.id}] Gerando novo QR a pedido (com limpeza)...`);
        recriarClient(s);
    }, 1200);
    res.json({ ok: true });
});

// Reinicia o servidor inteiro: dispara o REINICIAR.bat (mata processos travados,
// limpa travas e sobe de novo). Usado pelo botao "Reiniciar servidor" no painel.
app.post('/api/reiniciar', (req, res) => {
    res.json({ ok: true });
    const bat = path.join(__dirname, 'REINICIAR.bat');
    try {
        const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        console.log('Reinicio solicitado pelo painel.');
    } catch (e) {
        console.error('Erro ao reiniciar:', e.message);
    }
});

const PORT = process.env.PORT || 3000;
// Escuta em todas as interfaces para permitir acesso pela rede local/VPN.
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT} com ${NUM_SESSOES} sessoes.`);
});
