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
// CACHE DE VALIDAÇÕES (evita reconsultar o mesmo número)
// ==========================================
const CACHE_FILE = path.join(__dirname, 'cache_validacao.json');
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_DIAS || '7', 10) * 24 * 60 * 60 * 1000;
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { cache = {}; }
let cacheDirty = false;
function salvarCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try { fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {}); } catch (_) { /* ignora */ }
}
setInterval(salvarCache, 5000);

// Busca o nome público do WhatsApp (best effort — pode vir vazio por privacidade).
async function buscarNome(client, whatsappId) {
    try {
        const c = await client.getContactById(whatsappId);
        return (c && (c.verifiedName || c.pushname || c.name || '')) || '';
    } catch (_) { return ''; }
}

// Pasta onde os resultados ficam salvos no servidor.
const RESULTADOS_DIR = path.join(__dirname, 'resultados');
try { fs.mkdirSync(RESULTADOS_DIR, { recursive: true }); } catch (_) { /* ignora */ }

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
        try { s.numero = (client.info && client.info.wid && client.info.wid.user) ? client.info.wid.user : ''; }
        catch (_) { s.numero = ''; }
        console.log(`[${id}] Conectado e pronto!` + (s.numero ? ` (${s.numero})` : ''));
    });

    client.on('auth_failure', (msg) => {
        s.ready = false;
        s.qr = '';
        console.error(`[${id}] Falha de autenticacao:`, msg);
    });

    client.on('disconnected', async (reason) => {
        s.ready = false;
        s.qr = '';
        s.numero = '';
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
        numero: '',
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
        numero: s.ready ? (s.numero || '') : '',
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
    const trazerNome = !!req.body.trazerNome;

    // 1) CACHE — se já consultamos esse número recentemente, devolve na hora.
    const cached = cache[numero];
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS && (!trazerNome || cached.nome)) {
        return res.json({ valido: cached.valido, nome: cached.nome || '', cache: true });
    }

    let s;
    try { s = await pegarSessao(); }
    catch (e) { return res.status(503).json({ erro: e.message }); }

    const whatsappId = `${numero}@c.us`;
    // 2) RETRY — tenta até 3 vezes em caso de erro temporário.
    let tentativas = 0, ultimoErro;
    while (tentativas < 3) {
        tentativas++;
        try {
            const numberId = await s.client.getNumberId(numero); // null se não tiver WhatsApp
            const registrado = !!numberId;
            let nome = '';
            if (registrado && trazerNome) {
                nome = await buscarNome(s.client, (numberId && numberId._serialized) || whatsappId);
            }
            liberarSessao(s);
            cache[numero] = { valido: registrado, nome, ts: Date.now() };
            cacheDirty = true;
            return res.json({ valido: registrado, nome, sessao: s.id });
        } catch (error) {
            ultimoErro = error;
            if (tentativas < 3) await sleep(800);
        }
    }
    liberarSessao(s);
    console.error(`[${s.id}] Erro ao consultar ${numero}:`, ultimoErro && ultimoErro.message);
    res.status(500).json({ erro: 'Erro interno ao consultar numero.' });
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
    s.numero = '';
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

// Salva o resultado da validação numa pasta no servidor (resultados/).
app.post('/api/salvar-resultado', (req, res) => {
    const { linhas, cabecalho } = req.body || {};
    if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ erro: 'Sem dados para salvar.' });
    const agora = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nomeArq = `resultado_${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}${pad(agora.getMinutes())}${pad(agora.getSeconds())}.csv`;
    const caminho = path.join(RESULTADOS_DIR, nomeArq);
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const todas = (Array.isArray(cabecalho) ? [cabecalho] : []).concat(linhas);
    const csv = '﻿' + todas.map(r => (Array.isArray(r) ? r : [r]).map(esc).join(',')).join('\r\n');
    try {
        fs.writeFileSync(caminho, csv, 'utf8');
        console.log(`Resultado salvo no servidor: ${nomeArq} (${linhas.length} linhas)`);
        res.json({ ok: true, arquivo: 'resultados/' + nomeArq, total: linhas.length });
    } catch (e) {
        console.error('Erro ao salvar resultado:', e.message);
        res.status(500).json({ erro: 'Erro ao salvar no servidor.' });
    }
});

// ==========================================
// HISTÓRICO (protegido por senha própria)
// ==========================================
const SENHA_HISTORICO = process.env.SENHA_HISTORICO || '1245';
function senhaHistOk(req, res) {
    const s = req.headers['x-senha-hist'] || (req.body && req.body.senha) || '';
    if (s === SENHA_HISTORICO) return true;
    res.status(401).json({ erro: 'Senha do histórico incorreta.' });
    return false;
}

// Lista os resultados salvos no servidor.
app.post('/api/historico', (req, res) => {
    if (!senhaHistOk(req, res)) return;
    let arquivos = [];
    try {
        arquivos = fs.readdirSync(RESULTADOS_DIR)
            .filter(f => f.toLowerCase().endsWith('.csv'))
            .map(f => {
                const st = fs.statSync(path.join(RESULTADOS_DIR, f));
                return { nome: f, tamanho: st.size, data: st.mtime.toLocaleString('pt-BR'), ts: st.mtimeMs };
            })
            .sort((a, b) => b.ts - a.ts);
    } catch (_) { /* pasta pode nao existir ainda */ }
    res.json({ ok: true, arquivos });
});

// Retorna o conteúdo de um resultado salvo (para o navegador baixar).
app.post('/api/historico/arquivo', (req, res) => {
    if (!senhaHistOk(req, res)) return;
    const nome = path.basename((req.body && req.body.arquivo) || '');
    if (!nome || !nome.toLowerCase().endsWith('.csv')) return res.status(400).json({ erro: 'Arquivo inválido.' });
    const caminho = path.join(RESULTADOS_DIR, nome);
    if (!caminho.startsWith(RESULTADOS_DIR) || !fs.existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    try {
        res.json({ ok: true, nome, conteudo: fs.readFileSync(caminho, 'utf8') });
    } catch (e) {
        res.status(500).json({ erro: 'Erro ao ler o arquivo.' });
    }
});

// ==========================================
// WATCHDOG — recupera sozinho sessão travada (sem QR e sem conectar).
// ==========================================
const STUCK_MS = 70000;
setInterval(() => {
    const agora = Date.now();
    sessoes.forEach(s => {
        if (s.ready || s.reconectando || s.desconectandoManual) { s._semQrDesde = 0; return; }
        if (s.qr) { s._semQrDesde = 0; return; } // tem QR à mostra, tudo bem
        if (!s._semQrDesde) { s._semQrDesde = agora; return; }
        if (agora - s._semQrDesde > STUCK_MS) {
            console.warn(`[${s.id}] Travada sem QR — recuperando automaticamente...`);
            s._semQrDesde = 0;
            s.reconectando = true;
            Promise.race([s.client.destroy(), sleep(4000)]).catch(() => {}).finally(() => {
                matarChromeDaSessao(s.id);
                limparLock(s.id);
                setTimeout(() => { s.reconectando = false; recriarClient(s); }, 1200);
            });
        }
    });
}, 15000);

const PORT = process.env.PORT || 3000;
// Escuta em todas as interfaces para permitir acesso pela rede local/VPN.
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT} com ${NUM_SESSOES} sessoes.`);
});
