process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const gruposRegistrados = new Map();

const axios = require('axios');

const sharp = require('sharp');

// DONO DO BOT
const DONO = '557191165170@s.whatsapp.net'; // Altere para o número real do dono

const privateFloodCooldown = {}; // Objeto para armazenar o último tempo de resposta para cada chat privado
const FLOOD_COOLDOWN_TIME_MS = 5000; // 5 segundos de cooldown


// CONFIGURANDO BANCO DE DADOS POSTGRESQL

const { Client } = require('pg');

const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,

};

const dbClient = new Client(dbConfig);

async function isUserBlocked(userId) {
  const result = await dbClient.query('SELECT is_blocked FROM users WHERE user_id = $1', [userId]);
  return result.rows.length > 0 && result.rows[0].is_blocked;
}

async function getAllGroupParticipants(groupId) {
  try {
    const groupMetadata = await sock.groupMetadata(groupId);
    return groupMetadata?.participants?.map(p => p.id) || [];
  } catch (error) {
    console.error('Erro ao obter participantes do grupo:', error);
    return [];
  }
}


// Função para conectar ao banco de dados e testar a tabela 'users'
async function connectDB() {
  try {
    if (dbClient._connected) {
      console.log('⚠️ Conexão com o banco já está ativa.');
      return;
    }

    await dbClient.connect();
    console.log('✅ Conectado ao banco de dados PostgreSQL');

    // Testa se a tabela 'users' pode ser acessada
    const res = await dbClient.query('SELECT user_id FROM users LIMIT 1');
    console.log('📦 Teste de leitura da tabela users bem-sucedido:', res.rows.length, 'registro(s) encontrados.');
  } catch (err) {
    console.error('❌ Erro ao conectar ou ler a tabela users:', err.message || err);
  }
}

connectDB();

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Usando a versão mais recente do Baileys: ${version}, mais recente: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexão fechada devido a ${lastDisconnect?.error}, reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log('Tentando reconectar...');
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('Conexão aberta');
    }

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Por favor, escaneie o QR Code acima.');
    }
  });

  // INÍCIO DO HANDLER DE MENSAGENS (MESSAGES.UPSERT)
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      const jid = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';
      const isPrivate = jid.endsWith('@s.whatsapp.net');
      const senderJid = msg.key.participant || jid;
      const senderNumber = senderJid.split('@')[0];


      // --- FUNÇÕES AUXILIARES (declaradas dentro do escopo para acesso a sock, dbClient, etc.) ---

      async function getUserCargoFromDatabase(userId) {
        try {
          const result = await dbClient.query(`
      SELECT c.nome AS nome, c.id AS cargo_id
      FROM users u
      JOIN cargos c ON u.cargo_id = c.id
      WHERE u.user_id = $1
    `, [userId]);

          if (result.rows.length > 0) {
            return result.rows[0]; // ex: { nome: 'Capitão', cargo_id: 2 }
          } else {
            return { nome: 'Recruta', cargo_id: 999 }; // Padrão para não registrados
          }
        } catch (err) {
          console.error('Erro ao obter cargo do usuário:', err);
          return { nome: 'Recruta', cargo_id: 999 }; // Em caso de erro, assume Recruta
        }
      }

      async function verificarPermissao(userId, comandoNome) {
        const userRole = await getUserCargoFromDatabase(userId);

        // Se for Recruta, não tem permissão para nenhum comando moderado
        if (userRole.cargo_id === 999) return false;

        const comando = await dbClient.query(`
    SELECT nivel_minimo FROM comandos WHERE nome = $1 AND ativo = TRUE
  `, [comandoNome]);

        if (comando.rowCount === 0) return false;

        const nivelMinimo = comando.rows[0].nivel_minimo;
        return userRole.cargo_id <= nivelMinimo;
      }

      async function garantirUsuarioRegistrado(userId) {
        const role = await getUserCargoFromDatabase(userId);
        if (role.cargo_id === 999) return; // Recruta não é registrado

        await dbClient.query(`
    INSERT INTO users (user_id, cargo_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, role.cargo_id]);
      }
      // Função auxiliar para incrementar contadores
      async function incrementCounter(counterName) {
        try {
          const result = await dbClient.query(`
      INSERT INTO counters (counter_name, value)
      VALUES ($1, 1)
      ON CONFLICT (counter_name)
      DO UPDATE SET value = counters.value + 1, last_update = NOW()
      RETURNING value
    `, [counterName]);

          return result.rows[0].value;

        } catch (error) {
          console.error('Erro ao incrementar contador:', error);
          throw error;
        }
      }

      async function getAllGroupParticipants(groupId) {
        try {
          const groupMetadata = await sock.groupMetadata(groupId);
          return groupMetadata?.participants?.map(p => p.id) || [];
        } catch (error) {
          console.error('Erro ao obter participantes do grupo:', error);
          return [];
        }
      }


      async function usarGemini(pergunta) {
        const apiKey = process.env.GEMINI_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;


        try {
          const response = await axios.post(url, {
            contents: [{ parts: [{ text: pergunta }] }]
          }, {
            headers: { 'Content-Type': 'application/json' }
          });

          const resposta = response.data.candidates[0]?.content?.parts[0]?.text;
          return resposta || "🤖 Não consegui entender.";
        } catch (error) {
          console.error('Erro na API Gemini:', error.response?.data || error.message);
          return '❌ Erro ao chamar a IA.';
        }
      }
      // --- FIM DAS FUNÇÕES AUXILIARES ---

      if (text?.startsWith('!')) {
        console.log('Comando recebido:', text);
        const [command, ...args] = text.split(' '); // args é definido AQUI
        const lowerCommand = command.toLowerCase();
        // await logCommand(lowerCommand); // Logar o comando           
        const reply = (msg) => sock.sendMessage(jid, msg);

        const ignorarBloqueio = ['!contato', '!primeiroacesso'];

        if (!ignorarBloqueio.includes(lowerCommand)) {
          const bloqueado = await isUserBlocked(senderJid);
          if (bloqueado) {
            await reply({ text: '🚫 Você está bloqueado e não pode usar comandos.' });
            return;
          }
        }

        switch (lowerCommand) {

          case '!help':
            try {
              const textoHelp = `🤖 *COMANDOS DISPONÍVEIS* 🤖

🔰 *GERAIS (Todos os usuários)*
!ping — Verifica se o bot está online
!s — Cria figurinha a partir de imagem
!dado XdY — Rola dados no estilo (ex: !3d6)
!perdi — Adiciona 1 ao contador de derrotas
!menosuma — Registra um ataque do devorador
!sorteio N — Sorteia N pessoas do grupo
!cargo — Mostra seu cargo atual
!ranks — Exibe a hierarquia dos cargos
!inicio — Mensagem inicial e orientações
!contato — Fale com o dono do bot

👥 *MODERAÇÃO (Capitão+)*
!all — Menciona todos os membros do grupo
!listarcargos — Lista usuários com cargos
!lock — Bloqueia ou desbloqueia o grupo

🛡️ *ADMINISTRAÇÃO (Oficial+)*
!ban @usuário — Remove alguém do grupo
!addcargo @usuário <cargo> — Atribui um cargo
!removecargo @usuário — Remove o cargo de alguém

👑 *ALTA AUTORIDADE (Imperador+)*
!bloquear @usuário — Ativa ou desativa comandos de um usuário
!ia <pergunta> — Consulta a IA para respostas`;

              await reply({ text: textoHelp });
            } catch (error) {
              console.error('Erro ao exibir !help:', error);
              await reply({ text: '❌ Não foi possível mostrar os comandos no momento.' });
            }
            break;

          case '!ping':
            try {
              // Verifica se o usuário está bloqueado no banco
              const result = await dbClient.query(
                'SELECT is_blocked FROM users WHERE user_id = $1',
                [senderJid]
              );

              if (result.rows.length > 0 && result.rows[0].is_blocked) {
                await reply({ text: '🚫 Você está bloqueado e não pode usar comandos.' });
                return;
              }

              await sock.sendMessage(jid, { text: '🏓 Pong!' });
            } catch (err) {
              console.error('❌ Erro ao executar !ping:', err);
              await reply({ text: '❌ Ocorreu um erro ao processar o comando.' });
            }
            break;

          case '!all':
            try {
              if (!jid.endsWith('@g.us')) {
                await sock.sendMessage(jid, { text: '⚠️ O comando !all só pode ser usado em grupos.' });
                break;
              }

              const participants = await getAllGroupParticipants(jid);
              const mentions = participants.filter(id => id !== sock.user.id); // Exclui o próprio bot
              const texto = '📍Chamando todo mundo📍';

              await sock.sendMessage(jid, { text: texto, mentions });
            } catch (error) {
              console.error('Erro no comando !all:', error);
              await sock.sendMessage(jid, { text: '❌ Erro ao mencionar todos os participantes.' });
            }
            break;

          case '!s':
            try {
              const messageType = Object.keys(msg.message || {})[0];
              let mediaMessage;

              if (['imageMessage'].includes(messageType)) {
                mediaMessage = msg;
              } else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                mediaMessage = {
                  key: {
                    remoteJid: jid,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    fromMe: false,
                    participant: msg.message.extendedTextMessage.contextInfo.participant,
                  },
                  message: msg.message.extendedTextMessage.contextInfo.quotedMessage,
                };
              } else {
                await reply({ text: '⚠️ Envie ou responda uma imagem para transformar em figurinha.' });
                break;
              }

              const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage,
              });

              const webpBuffer = await sharp(buffer)
                .resize(512, 512, {
                  fit: 'contain',
                  background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .webp({ quality: 80 })
                .toBuffer();

              await sock.sendMessage(jid, {
                sticker: webpBuffer
              }, { quoted: msg });

            } catch (error) {
              console.error('Erro ao processar !s:', error);
              await reply({ text: '❌ Erro ao criar a figurinha. Verifique se é uma imagem válida.' });
            }
            break;

          case '!dado':
            try {
              if (!args[0]) {
                await reply({ text: '🎲 Uso: !<número>d<lados> (ex: !3d6)' });
                break;
              }

              const formatoDado = args[0].toLowerCase();
              const match = formatoDado.match(/^(\d+)d(\d+)$/);

              if (!match) {
                await reply({ text: '⚠️ Formato inválido. Use: !<número>d<lados> (ex: !3d6)' });
                break;
              }

              const numDados = parseInt(match[1]);
              const numLados = parseInt(match[2]);

              if (isNaN(numDados) || numDados < 1 || isNaN(numLados) || numLados < 1) {
                await reply({ text: '⚠️ Valores inválidos.' });
                break;
              }

              if (numDados > 20) {
                await reply({ text: '⚠️ Máximo de 20 dados permitidos por vez.' });
                break;
              }

              const resultados = Array.from({ length: numDados }, () =>
                Math.floor(Math.random() * numLados) + 1
              );
              const total = resultados.reduce((a, b) => a + b, 0);

              await reply({
                text: `🎲 Resultado: *${numDados}d${numLados}*\n[${resultados.join(', ')}] → Total: *${total}*`
              });
            } catch (error) {
              console.error('Erro ao rolar dados (!dado):', error);
              await reply({ text: '❌ Erro ao rolar dados. Tente novamente.' });
            }
            break;

          case '!sorteio':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos.' });
                break;
              }

              const numSorteadosStr = args[0];
              const numSorteados = numSorteadosStr ? parseInt(numSorteadosStr) : 1;

              if (isNaN(numSorteados) || numSorteados < 1) {
                await reply({ text: '⚠️ Uso: !sorteio <número_de_vencedores> (padrão: 1)' });
                break;
              }

              const participantes = await getAllGroupParticipants(jid);
              if (participantes.length === 0) {
                await reply({ text: '⚠️ Não há participantes neste grupo para sortear.' });
                break;
              }

              if (numSorteados > participantes.length) {
                await reply({ text: '⚠️ O número de vencedores é maior que o número de participantes.' });
                break;
              }

              const participantesRestantes = [...participantes]; // Cópia
              const vencedores = [];

              for (let i = 0; i < numSorteados; i++) {
                const indice = Math.floor(Math.random() * participantesRestantes.length);
                const sorteado = participantesRestantes.splice(indice, 1)[0];
                vencedores.push(sorteado);
              }

              const menções = vencedores.map(id => `@${id.split('@')[0]}`).join(', ');
              const mensagem = vencedores.length === 1
                ? `🎉 O vencedor foi: ${menções}`
                : `🎉 Os vencedores foram: ${menções}`;

              await reply({ text: mensagem, mentions: vencedores });
            } catch (error) {
              console.error('Erro ao executar !sorteio:', error);
              await reply({ text: '❌ Erro ao realizar o sorteio.' });
            }
            break;

          case '!contato':
            try {
              const donoNumero = DONO.split('@')[0]; // Remove o @s.whatsapp.net
              const linkContato = `https://wa.me/${donoNumero}`;
              const mensagemContato = `📞 *Contato com o Dono do Bot*\n\nSe você precisa de ajuda, tem sugestões ou deseja relatar algo:\n➡️ Clique aqui para falar diretamente:\n${linkContato}`;

              await reply({ text: mensagemContato });
            } catch (error) {
              console.error('Erro ao processar !contato:', error);
              await reply({ text: '❌ Erro ao gerar o link de contato com o dono.' });
            }
            break;

          case '!ranks':
            try {
              const textoRanks = `📜 *CARGOS E FUNÇÕES* 📜

🔹 *Recruta*  
Acesso básico. Pode usar comandos simples.

🔸 *Capitão*  
Pode sortear membros, ver cargos e mencionar todos.

🔸 *Oficial*  
Administra usuários com banimentos e promoções.

🔸 *Comandante*  
Comando quase total do sistema, incluindo cargos.

👑 *Imperador*  
Controle absoluto. Pode até bloquear comandos de outros.

Use *!cargo* para ver seu cargo atual.
`;

              await reply({ text: textoRanks });
            } catch (error) {
              console.error('Erro ao exibir ranks:', error);
              await reply({ text: '❌ Não foi possível exibir os ranks no momento.' });
            }
            break;

          case '!inicio':
            try {
              const texto = `👋 *Bem-vindo ao LeinadoBot!*

Este bot funciona tanto em *grupos* quanto no *privado*.

🔹 *No privado*:  
Use comandos como !ping, !dado, !perdi, !s e outros para se divertir ou testar.

🔹 *Em grupos*:  
O bot ajuda na *organização*, *moderação* e *interação* com os membros.

🛡️ Cargos definem o que cada um pode fazer. Veja com *!ranks*.  
📞 Para suporte, use *!contato*.  
📜 Use *!help* para ver tudo que pode fazer aqui.

Aproveite o poder do LeinadoBot!`;

              await reply({ text: texto });
            } catch (error) {
              console.error('Erro ao executar !inicio:', error);
              await reply({ text: '❌ Não foi possível exibir a mensagem de boas-vindas.' });
            }
            break;

          case '!menosuma':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos.' });
                break;
              }

              const currentCount = await incrementCounter('menos_uma');
              const mentions = [
                '557191165170@s.whatsapp.net', // Daniel
                '557182903278@s.whatsapp.net', // Melky
                '557199670849@s.whatsapp.net', // Michael
                '557181984714@s.whatsapp.net', // Marcos
                '557181766942@s.whatsapp.net'  // Matheus
              ];

              const texto = `O devorador ataca novamente!\n -1\nVítimas: *${currentCount}*\n\n${mentions.map(id => `@${id.split('@')[0]}`).join(' ')}`;
              await sock.sendMessage(jid, { text: texto, mentions });

            } catch (err) {
              console.error('Erro no comando !menosuma:', err);
              await reply({ text: '❌ Erro ao registrar o ataque do devorador.' });
            }
            break;

          case '!perdi':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos.' });
                break;
              }

              const currentCount = await incrementCounter('perdi');
              const mentions = [
                '557191165170@s.whatsapp.net', // Daniel
                '557182903278@s.whatsapp.net', // Melky
                '557199670849@s.whatsapp.net', // Michael
                '557181984714@s.whatsapp.net', // Marcos
                '557181766942@s.whatsapp.net'  // Matheus
              ];

              const texto = `Perdemos *${currentCount}* vez(es)... 😔\nMarcando: ${mentions.map(id => `@${id.split('@')[0]}`).join(' ')}`;
              await sock.sendMessage(jid, { text: texto, mentions });

            } catch (err) {
              console.error('Erro no comando !perdi:', err);
              await reply({ text: '❌ Erro ao registrar a derrota.' });
            }
            break;

          // Atualizados para o banco novo

          // Atualizados a nova verificação de cargo 
          case '!cargo':
            try {
              const role = await getUserCargoFromDatabase(senderJid);

              if (role.cargo_id === 999) {
                await reply({ text: '🏷️ Seu cargo atual é: *Recruta*.\nVocê ainda não foi promovido por ninguém.' });
                break;
              }

              // Obtém info detalhada se o usuário está cadastrado
              const result = await dbClient.query(`
      SELECT u.last_rank_date, u.rank_giver_id
      FROM users u
      WHERE u.user_id = $1
    `, [senderJid]);

              const { last_rank_date, rank_giver_id } = result.rows[0];
              let mensagem = `🏷️ *Seu Cargo Atual:*\n- Cargo: *${role.nome}*`;

              if (last_rank_date) {
                const dataFormatada = new Date(last_rank_date).toLocaleDateString('pt-BR');
                mensagem += `\n- Desde: ${dataFormatada}`;
              }

              if (rank_giver_id) {
                const nomeDoador = rank_giver_id.split('@')[0];
                mensagem += `\n- Atribuído por: @${nomeDoador}`;
                await reply({ text: mensagem, mentions: [rank_giver_id] });
              } else {
                await reply({ text: mensagem });
              }

              // Registra log apenas se não for recruta
              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, null, '!cargo']);

            } catch (error) {
              console.error('Erro no comando !cargo:', error);
              await reply({ text: '❌ Não foi possível recuperar seu cargo no momento.' });
            }
            break;

          case '!addcargo':
            try {
              if (args.length < 2 || !args[0].startsWith('@')) {
                await reply({ text: '⚠️ Uso correto: !addcargo @usuario <cargo>' });
                break;
              }

              const targetUserIdAdd = args[0].slice(1) + '@s.whatsapp.net';
              const cargoNome = args[1].charAt(0).toUpperCase() + args[1].slice(1).toLowerCase();

              const podeUsar = await verificarPermissao(senderJid, '!addcargo');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const senderRole = await getUserCargoFromDatabase(senderJid);
              const senderCargoId = senderRole.cargo_id;

              const cargoResult = await dbClient.query(`SELECT id FROM cargos WHERE nome = $1`, [cargoNome]);
              if (cargoResult.rows.length === 0) {
                await reply({ text: `⚠️ O cargo *${cargoNome}* não existe.` });
                break;
              }
              const novoCargoId = cargoResult.rows[0].id;

              const alvoRole = await getUserCargoFromDatabase(targetUserIdAdd);
              const cargoAtualAlvo = alvoRole.cargo_id !== 999 ? alvoRole.cargo_id : null;

              if (
                senderCargoId > novoCargoId ||
                (cargoAtualAlvo !== null && senderCargoId > cargoAtualAlvo)
              ) {
                await reply({
                  text: '❌ Para atribuir um cargo, você precisa ter um cargo igual ou superior ao que está tentando conceder.'
                });
                break;
              }

              await dbClient.query(`
      INSERT INTO users (user_id, cargo_id, last_rank_date, rank_giver_id)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (user_id) DO UPDATE
      SET cargo_id = $2, last_rank_date = NOW(), rank_giver_id = $3
    `, [targetUserIdAdd, novoCargoId, senderJid]);

              await reply({ text: `✅ Cargo *${cargoNome}* atribuído a ${args[0]}.` });

              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, targetUserIdAdd, '!addcargo']);

            } catch (error) {
              console.error('Erro no comando !addcargo:', error);
              await reply({ text: '❌ Erro ao tentar atribuir o cargo.' });
            }
            break;

          case '!removecargo':
            try {
              if (!args[0]?.startsWith('@')) {
                await reply({ text: '⚠️ Uso correto: !removecargo @usuario' });
                break;
              }

              const targetUserId = args[0].slice(1) + '@s.whatsapp.net';

              // Verifica se quem envia tem permissão
              const podeUsar = await verificarPermissao(senderJid, '!removecargo');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              // Cargo do remetente
              const senderRole = await getUserCargoFromDatabase(senderJid);
              const senderCargoId = senderRole.cargo_id;

              // Cargo do alvo
              const alvoRole = await getUserCargoFromDatabase(targetUserId);
              if (alvoRole.cargo_id === 999) {
                await reply({ text: '⚠️ Esse usuário ainda não possui cargo para ser removido.' });
                break;
              }
              const targetCargoId = alvoRole.cargo_id;

              // Verificação de hierarquia
              if (senderCargoId >= targetCargoId) {
                await reply({ text: '❌ Você não tem permissão para remover o cargo deste usuário.' });
                break;
              }

              // Remove o cargo
              await dbClient.query(`
      UPDATE users
      SET cargo_id = NULL, last_rank_date = NOW(), rank_giver_id = $1
      WHERE user_id = $2
    `, [senderJid, targetUserId]);

              await reply({ text: `✅ Cargo removido de ${args[0]}.` });

              // Log do comando
              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, targetUserId, '!removecargo']);

            } catch (error) {
              console.error('Erro no comando !removecargo:', error);
              await reply({ text: '❌ Falha ao tentar remover o cargo.' });
            }
            break;

          case '!listarcargos':
            try {
              const podeUsar = await verificarPermissao(senderJid, '!listarcargos');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const filtros = args.map(arg => arg.toLowerCase());
              const grupoSomente = filtros.includes('grupo');
              const nivelFiltro = filtros.find(f => !isNaN(f)) ?? null;

              let query = `
      SELECT u.user_id, c.nome AS cargo, c.id AS cargo_id
      FROM users u
      JOIN cargos c ON u.cargo_id = c.id
    `;
              const params = [];

              if (nivelFiltro !== null) {
                query += ' WHERE c.id <= $1';
                params.push(Number(nivelFiltro));
              }

              query += ' ORDER BY c.id';

              const results = await dbClient.query(query, params);

              // Filtra pelos membros do grupo, se solicitado
              let usuariosFiltrados = results.rows;
              const mentions = [];

              if (grupoSomente) {
                const grupoMembros = await sock.groupMetadata(jid);
                const membrosGrupo = grupoMembros.participants.map(p => p.id);
                usuariosFiltrados = results.rows.filter(row => membrosGrupo.includes(row.user_id));
              }

              if (usuariosFiltrados.length === 0) {
                await reply({ text: 'ℹ️ Nenhum usuário encontrado com os filtros aplicados.' });
                break;
              }

              let mensagem = '📜 *Lista de Usuários com Cargos:* 📜\n\n';
              for (const { user_id, cargo } of usuariosFiltrados) {
                const nome = user_id.split('@')[0];
                mensagem += `- @${nome}: *${cargo}*\n`;
                mentions.push(user_id);
              }

              await sock.sendMessage(jid, { text: mensagem.trim(), mentions });

              // Loga o uso apenas se usuário tiver cargo válido
              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, null, '!listarcargos']);

            } catch (error) {
              console.error('Erro ao listar cargos:', error);
              await reply({ text: '❌ Falha ao listar os cargos.' });
            }
            break;

          case '!bloquear':
            try {
              if (!jid.endsWith('@g.us') && !isPrivate) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos ou no privado.' });
                break;
              }

              if (!args[0]?.startsWith('@')) {
                await reply({ text: '⚠️ Uso correto: !bloquear @usuario' });
                break;
              }

              const targetUserId = args[0].slice(1) + '@s.whatsapp.net';

              const podeUsar = await verificarPermissao(senderJid, '!bloquear');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const result = await dbClient.query(
                `UPDATE users 
       SET is_blocked = NOT COALESCE(is_blocked, FALSE)
       WHERE user_id = $1
       RETURNING is_blocked`,
                [targetUserId]
              );

              if (result.rows.length === 0) {
                await reply({ text: '⚠️ Este usuário não está registrado no sistema.' });
                break;
              }

              const estadoAtual = result.rows[0].is_blocked;
              const statusMsg = estadoAtual ? 'bloqueado' : 'desbloqueado';
              await reply({ text: `✅ Usuário ${args[0]} ${statusMsg}.` });

              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, targetUserId, '!bloquear']);

            } catch (error) {
              console.error('Erro no comando !bloquear:', error);
              await reply({ text: '❌ Ocorreu um erro ao tentar atualizar o estado de bloqueio.' });
            }
            break;

          case '!ban':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ O comando !ban só pode ser usado em grupos.' });
                break;
              }

              if (args.length === 0 || !args[0].startsWith('@')) {
                await reply({ text: '❌ Uso correto: !ban @usuario' });
                break;
              }

              const targetUserId = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';

              const podeUsar = await verificarPermissao(senderJid, '!ban');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const senderRole = await getUserCargoFromDatabase(senderJid);
              const targetRole = await getUserCargoFromDatabase(targetUserId);

              // Não permite banir alguém com mesmo cargo ou superior
              if (targetRole && senderRole.cargo_id >= targetRole.cargo_id) {
                await reply({ text: '❌ Você não pode banir alguém do mesmo cargo ou superior.' });
                break;
              }

              const groupParticipants = await getAllGroupParticipants(jid);
              if (!groupParticipants.includes(targetUserId)) {
                await reply({ text: '❌ Este usuário não está no grupo.' });
                break;
              }

              await sock.groupParticipantsUpdate(jid, [targetUserId], 'remove');
              await reply({ text: `✅ Usuário ${args[0]} removido com sucesso.` });

              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, targetUserId, '!ban']);

            } catch (err) {
              console.error('Erro no comando !ban:', err);
              await reply({ text: '❌ Erro ao tentar banir o usuário.' });
            }
            break;

          case '!ia':
            try {
              const podeUsar = await verificarPermissao(senderJid, '!ia');
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              if (args.length === 0) {
                await reply({ text: '❓ Use: !ia <sua pergunta>' });
                break;
              }

              const pergunta = args.join(' ');
              await reply({ text: '🤖 Pensando...' });

              const resposta = await usarGemini(pergunta);
              const final = resposta?.trim() || '🤖 Não consegui formular uma resposta adequada.';

              await reply({ text: final });

              // Registra no log (exceto para comandos de Recruta)
              const senderCargo = await getUserCargoFromDatabase(senderJid);
              if (senderCargo.cargo_id < 4) {
                await dbClient.query(`
        INSERT INTO logs (user_id, alvo_id, comando)
        VALUES ($1, $2, $3)
      `, [senderJid, null, '!ia']);
              }

            } catch (err) {
              console.error('Erro no comando !ia:', err);
              await reply({ text: '❌ Ocorreu um erro ao tentar consultar a IA.' });
            }
            break;

          case '!lock':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos.' });
                break;
              }

              const comandoAtual = '!lock';
              const podeUsar = await verificarPermissao(senderJid, comandoAtual);
              if (!podeUsar) {
                await reply({ text: '🚫 Você não tem permissão para alterar as permissões do grupo.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const metadata = await sock.groupMetadata(jid);
              const estadoAtual = metadata.announce; // true = bloqueado
              const novoEstado = !estadoAtual;

              await sock.groupSettingUpdate(jid, novoEstado ? 'announcement' : 'not_announcement');

              const mensagemStatus = novoEstado
                ? '🔒 *Grupo bloqueado!* Agora apenas administradores podem enviar mensagens.'
                : '🔓 *Grupo desbloqueado!* Todos os membros podem enviar mensagens.';

              await reply({ text: mensagemStatus });

              const senderRole = await getUserCargoFromDatabase(senderJid);
              if (senderRole.cargo_id < 4) {
                await dbClient.query(`
        INSERT INTO logs (user_id, alvo_id, comando)
        VALUES ($1, $2, $3)
      `, [senderJid, null, comandoAtual]);
              }

            } catch (error) {
              console.error('Erro no comando !lock:', error);
              await reply({ text: '❌ Falha ao alterar o estado do grupo.' });
            }
            break;

          // Comandos Secretos

          case '!comandossecretos':
            try {
              const comandoAtual = '!comandossecretos';

              const podeUsar = await verificarPermissao(senderJid, comandoAtual);
              if (!podeUsar) {
                await reply({ text: '❌ Você não tem permissão para ver os comandos secretos.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              const textoSecreto = `🕵️‍♂️ *COMANDOS SECRETOS* 🕵️‍♂️

🔧 *Ajustes de Contadores*
!force <contador> <valor> — Define o valor exato de um contador (ex: !force perdi 42)
!fazol
!grupos — Lista os grupos em que o bot está
!mass <comando> <grupos> <mensagem> — Envia comandos para vários grupos simultaneamente

📢 *Mensagens Globais*
!mass — Envia uma mensagem para todos os grupos registrados

🛠️ *Manutenção e Testes*
(Outros comandos ocultos ainda em fase de elaboração...)`;

              await reply({ text: textoSecreto });

              const senderRole = await getUserCargoFromDatabase(senderJid);
              if (senderRole.cargo_id < 4) {
                await dbClient.query(
                  `INSERT INTO logs (user_id, alvo_id, comando)
         VALUES ($1, $2, $3)`,
                  [senderJid, null, comandoAtual]
                );
              }

            } catch (err) {
              console.error('Erro no comando !comandossecretos:', err);
              await reply({ text: '❌ Falha ao exibir comandos secretos.' });
            }
            break;

          case '!force':
            try {
              const comandoAtual = '!force';

              const podeUsar = await verificarPermissao(senderJid, comandoAtual);
              if (!podeUsar) {
                await reply({ text: '❌ Você não tem permissão para usar este comando.' });
                break;
              }

              await garantirUsuarioRegistrado(senderJid);

              if (args.length < 2) {
                await reply({ text: '⚠️ Use: !force <contador> <valor>' });
                break;
              }

              const nome = args[0].toLowerCase();
              const valor = parseInt(args[1]);

              if (isNaN(valor) || valor < 0) {
                await reply({ text: '⚠️ Valor inválido. Use um número inteiro positivo.' });
                break;
              }

              const existe = await dbClient.query('SELECT 1 FROM counters WHERE counter_name = $1', [nome]);
              if (existe.rowCount === 0) {
                await reply({ text: `⚠️ Contador *${nome}* não existe.` });
                break;
              }

              await dbClient.query(
                'UPDATE counters SET value = $1, last_update = CURRENT_TIMESTAMP WHERE counter_name = $2',
                [valor, nome]
              );

              await reply({ text: `🔧 Contador *${nome}* atualizado para *${valor}*.` });

              const senderRole = await getUserCargoFromDatabase(senderJid);
              if (senderRole.cargo_id < 4) {
                await dbClient.query(
                  `INSERT INTO logs (user_id, alvo_id, comando)
         VALUES ($1, $2, $3)`,
                  [senderJid, null, comandoAtual]
                );
              }

            } catch (err) {
              console.error('Erro no comando !force:', err);
              await reply({ text: '❌ Erro ao forçar valor do contador.' });
            }
            break;

          case '!mass':
            try {
              const senderRole = await getUserCargoFromDatabase(senderJid);
              if (!senderRole || senderRole.cargo_id > 1) { // 0 = Dono, 1 = Imperador
                await reply({ text: '🚫 Você não tem permissão para usar esse comando.' });
                break;
              }

              const tipoAcao = args[0]; // msg, lock, leave, ban
              const conteudoRaw = args.slice(2).join(' ');
              const isAll = args[1]?.toLowerCase() === 'all';

              const indices = isAll
                ? Array.from(gruposRegistrados.keys())
                : args[1]?.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));

              if (!tipoAcao || !indices || indices.length === 0) {
                await reply({ text: '⚠️ Uso: !mass <ação> <1,2,3|all> <mensagem ou @usuario>' });
                break;
              }

              const sucesso = [];
              const falha = [];

              for (const i of indices) {
                const gid = gruposRegistrados.get(i);
                if (!gid) {
                  falha.push(i);
                  continue;
                }

                try {
                  switch (tipoAcao) {
                    case 'msg':
                      if (!conteudoRaw) {
                        await reply({ text: '⚠️ Mensagem vazia. Use: !mass msg 1,2,3 Olá!' });
                        return;
                      }
                      await sock.sendMessage(gid, { text: conteudoRaw });
                      sucesso.push(i);
                      break;

                    case 'lock':
                      const metadata = await sock.groupMetadata(gid);
                      const estadoAtual = metadata.announce;
                      const novoEstado = estadoAtual ? 'not_announcement' : 'announcement';
                      await sock.groupSettingUpdate(gid, novoEstado);
                      sucesso.push(i);
                      break;

                    case 'leave':
                      await sock.sendMessage(gid, {
                        text: '🚪 O sistema detectou um longo período de ociosidade...\nPor isso, o bot está se retirando deste grupo. Voltem a interagir para termos motivo para retornar! 👋'
                      });
                      await sock.groupLeave(gid);
                      sucesso.push(i);
                      break;

                    case 'ban':
                      const alvoId = conteudoRaw.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                      if (!conteudoRaw || !alvoId.endsWith('@s.whatsapp.net')) {
                        await reply({ text: '⚠️ Use: !mass ban 1,3,4 @numero' });
                        return;
                      }

                      const participantes = await getAllGroupParticipants(gid);
                      if (!participantes.includes(alvoId)) {
                        falha.push(i);
                        continue;
                      }

                      await sock.groupParticipantsUpdate(gid, [alvoId], 'remove');
                      sucesso.push(i);
                      break;

                    default:
                      await reply({ text: `❌ Ação "${tipoAcao}" não reconhecida.` });
                      return;
                  }
                } catch (err) {
                  console.error(`Erro ao executar ${tipoAcao} em ${gid}:`, err);
                  falha.push(i);
                }
              }

              let resultado = `✅ Ação *${tipoAcao}* executada com sucesso em ${sucesso.length} grupo(s).`;
              if (falha.length) resultado += `\n⚠️ Falhou em: ${falha.join(', ')}`;

              await reply({ text: resultado.trim() });

              await dbClient.query(`
      INSERT INTO logs (user_id, alvo_id, comando)
      VALUES ($1, $2, $3)
    `, [senderJid, conteudoRaw || null, `!mass ${tipoAcao}`]);

            } catch (err) {
              console.error('Erro no comando !mass:', err);
              await reply({ text: '❌ Erro ao executar o comando em massa.' });
            }
            break;

          case '!fazol':
            try {
              if (!jid.endsWith('@g.us')) {
                await reply({ text: '⚠️ Este comando só pode ser usado em grupos.' });
                break;
              }

              const currentCount = await incrementCounter('fazol');

              const mentions = [
                '557191165170@s.whatsapp.net', // Daniel
                '557182903278@s.whatsapp.net', // Melky
                '557199670849@s.whatsapp.net', // Michael
                '557181984714@s.whatsapp.net', // Marcos
                '557181766942@s.whatsapp.net'  // Matheus
              ];

              const frases = [
                `💥 Mais um L pra conta! Já são *${currentCount}*...`,
                `🇧🇷 Pensamento socialista detectado. Total de L’s: *${currentCount}*.`,
                `✊ A revolução avança! Contador de L’s: *${currentCount}*.`,
                `🧠 O Lula vive nos pensamentos... *${currentCount}* vezes e contando.`,
                `📈 A cada L, um ministro sorri. Já temos *${currentCount}* registros.`
              ];

              const aleatoria = frases[Math.floor(Math.random() * frases.length)];
              const texto = `${aleatoria}\n\n🔔 Chamando os camaradas:\n${mentions.map(id => `@${id.split('@')[0]}`).join(' ')}`;

              await sock.sendMessage(jid, { text: texto, mentions });

              // Log opcional (caso deseje registrar o uso)
              await dbClient.query(
                `INSERT INTO logs (user_id, alvo_id, comando)
       VALUES ($1, $2, $3)`,
                [senderJid, null, '!fazol']
              );

            } catch (err) {
              console.error('Erro no comando !fazol:', err);
              await reply({ text: '❌ Erro ao registrar o L.' });
            }
            break;

          case '!grupos':
            try {
              const grupos = await sock.groupFetchAllParticipating();
              gruposRegistrados.clear();

              const entradas = Object.entries(grupos);
              if (entradas.length === 0) {
                await reply({ text: 'ℹ️ Nenhum grupo registrado no momento.' });
                break;
              }

              let mensagem = '📋 *Grupos Disponíveis:*\n\n';
              let i = 1;

              for (const [jid, data] of entradas) {
                gruposRegistrados.set(i, jid);
                mensagem += `${i}. ${data.subject}\n`;
                i++;
              }

              // Limita a resposta se for muito longa
              if (mensagem.length > 4000) {
                mensagem = mensagem.slice(0, 3900) + '\n... (lista cortada por limite de tamanho)';
              }

              await reply({ text: mensagem.trim() });

            } catch (err) {
              console.error('Erro ao listar grupos:', err);
              await reply({ text: '❌ Não foi possível listar os grupos.' });
            }
            break;

          //////////////////////////

          default:
            console.log(`Comando desconhecido: ${command}`);
            await sock.sendMessage(jid, { text: 'Comando desconhecido. Use !help para ver os comandos disponíveis.' });
            break;
        }
      } else if (isPrivate && text) {
        const now = Date.now();
        if (!privateFloodCooldown[jid] || now - privateFloodCooldown[jid] > FLOOD_COOLDOWN_TIME_MS) {
          await sock.sendMessage(jid, { text: '🤖 Este é um robô. Use comandos iniciados com "!" (ex: !inicio ou !help).' });
          privateFloodCooldown[jid] = now;
        }
      }
    }
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

connectToWhatsApp();
