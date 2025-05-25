const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const sharp = require('sharp');

// DONO DO BOT
const DONO = '557191165170@s.whatsapp.net'; // Altere para o número real do dono


const privateFloodCooldown = {}; // Objeto para armazenar o último tempo de resposta para cada chat privado
const FLOOD_COOLDOWN_TIME_MS = 5000; // 5 segundos de cooldown

//PATENTES

const roles = {
    recruta: 'Recruta',
    capitao: 'Capitão',
    general: 'General',
    comandante: 'Comandante',
    imperador: 'Imperador',
    dono: 'Dono',
};


// CONFIGURANDO BANCO DE DADOS POSTGRESQL

const { Client } = require('pg');

const dbConfig = {
    user: 'postgres',
    host: 'localhost',
    database: 'santana',
    password: '1475',
    port: 5432,
};

const dbClient = new Client(dbConfig);

// Função para conectar ao banco de dados
async function connectDB() {
    try {
        await dbClient.connect();
        console.log('Conectado ao banco de dados PostgreSQL');
    } catch (err) {
        console.error('Erro ao conectar ao banco de dados:', err);
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

            async function getUserRoleFromDatabase(userId) {
                try {
                    const result = await dbClient.query(
                        'SELECT role FROM users WHERE user_id = $1',
                        [userId]
                    );
                    return result.rows[0]?.role;
                } catch (error) {
                    console.error('Erro ao buscar cargo do usuário no banco:', error);
                    return 'Recruta'; // Padrão se não encontrar ou erro
                }
            }
            async function logCommand(commandUsed) {
                try {
                    await dbClient.query(
                        'INSERT INTO logs (user_id, user_number, chat_id, command) VALUES ($1, $2, $3, $4)',
                        [senderJid, senderNumber, jid, commandUsed]
                    );
                    console.log(`Comando "${commandUsed}" logado no banco de dados.`);
                } catch (error) {
                    console.error('Erro ao logar comando:', error);
                }
            }

            async function getCounter(counterName) {
                try {
                    const result = await dbClient.query(
                        'SELECT value FROM counters WHERE counter_name = $1',
                        [counterName]
                    );
                    return result.rows[0]?.value || 0;
                } catch (error) {
                    console.error(`Erro ao obter contador "${counterName}":`, error);
                    return 0;
                }
            }

            async function incrementCounter(counterName) {
                try {
                    const result = await dbClient.query(
                        'UPDATE counters SET value = value + 1, last_update = NOW() WHERE counter_name = $1 RETURNING value',
                        [counterName]
                    );
                    return result.rows[0]?.value || 0;
                } catch (error) {
                    console.error(`Erro ao incrementar contador "${counterName}":`, error);
                    return 0;
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

            const roleHierarchy = ['Recruta', 'Capitão', 'General', 'Comandante', 'Imperador', 'Dono'];

            function isRoleAuthorized(userRole, allowedRoles, targetRole = null) {
                const userRank = roleHierarchy.indexOf(userRole);
                const targetRank = targetRole ? roleHierarchy.indexOf(targetRole) : -1;

                if (userRank === -1) {
                    console.error(`Cargo não reconhecido: ${userRole}`);
                    return false;
                }

                // Dono tem acesso a tudo
                if (userRole === 'Dono') {
                    return true;
                }

                // Verifica se o cargo do usuário está na lista de cargos autorizados
                const hasBasePermission = allowedRoles.includes(userRole);

                // Se houver um cargo alvo, verifica se o usuário tem nível superior
                const canActOnTarget = targetRole ? userRank > targetRank : true;

                return hasBasePermission && canActOnTarget;
            }

            // --- FIM DAS FUNÇÕES AUXILIARES ---


            if (text?.startsWith('!')) {
                console.log('Comando recebido:', text);
                const [command, ...args] = text.split(' '); // args é definido AQUI
                const lowerCommand = command.toLowerCase();
               // await logCommand(lowerCommand); // Logar o comando           
                const reply = (msg) => sock.sendMessage(jid, msg);
                switch (lowerCommand) {
                    case '!ping':
                        try {
                            await sock.sendMessage(jid, { text: '🏓 Pong!' });
                            console.log('✅ Pong enviado com sucesso.');
                        } catch (err) {
                            console.error('❌ Erro ao enviar Pong:', err);
                        }
                        break;
case '!help':
    try {
        const textoHelp = `🤖 *COMANDOS DISPONÍVEIS* 🤖

*BÁSICOS*
!ping — Testa se o bot está ativo
!perdi / !menosuma — Contadores personalizados
!dado XdY — Rola dados (ex: !3d6)
!s — Gera figurinha de imagem
!sorteio N — Sorteia N pessoas do grupo
!cargo — Mostra seu cargo atual
!ranks — Exibe cargos e permissões

*ADMINISTRATIVOS*
!addcargo @usuário <cargo>
!removecargo @usuário
!ban @usuário
!bloquear @usuário
!listarcargos

Ajuda: use !contato
ℹ️ Veja o que cada cargo pode usar com !ranks`;

        await reply({ text: textoHelp });
    } catch (error) {
        console.error('Erro ao exibir !help:', error);
        await reply({ text: '❌ Não foi possível mostrar os comandos no momento.' });
    }
    break;

case '!perdi':
    try {
        if (!jid.endsWith('@g.us')) {
            await sock.sendMessage(jid, { text: '⚠️ O comando !perdi só pode ser usado em grupos.' });
            break;
        }

        const currentCount = await incrementCounter('perdi');
        const specificUsers = [
            '557191165170@s.whatsapp.net', // Daniel
            '557182903278@s.whatsapp.net', // Melky
            '557199670849@s.whatsapp.net', // Michael
            '557181984714@s.whatsapp.net', // Marcos
            '557181766942@s.whatsapp.net'  // Matheus
        ];

        const mentions = specificUsers;
        const mentionText = `Perdemos ${currentCount} vez(es), e subindo! 😔\nMarcando: ${mentions.map(id => `@${id.split('@')[0]}`).join(' ')}`;

        await sock.sendMessage(jid, { text: mentionText, mentions });
    } catch (error) {
        console.error('Erro no comando !perdi:', error);
        await sock.sendMessage(jid, { text: '❌ Erro ao processar o comando !perdi.' });
    }
    break;

case '!menosuma':
    try {
        if (!jid.endsWith('@g.us')) {
            await sock.sendMessage(jid, { text: '⚠️ O comando !menosuma só pode ser usado em grupos.' });
            break;
        }

        const currentCount = await incrementCounter('menos_uma');
        const specificUsers = [
            '557191165170@s.whatsapp.net', // Daniel
            '557182903278@s.whatsapp.net', // Melky
            '557199670849@s.whatsapp.net', // Michael
            '557181984714@s.whatsapp.net', // Marcos
            '557181766942@s.whatsapp.net'  // Matheus
        ];

        const mentions = specificUsers;
        const mentionText = `O devorador ataca novamente!\n - 1 \nVítimas - ${currentCount}\n\n${mentions.map(id => `@${id.split('@')[0]}`).join(' ')}`;

        await sock.sendMessage(jid, { text: mentionText, mentions });
    } catch (error) {
        console.error('Erro no comando !menosuma:', error);
        await sock.sendMessage(jid, { text: '❌ Erro ao processar o comando !menosuma.' });
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






case '!ban':
    try {
        if (!jid.endsWith('@g.us')) {
            await sock.sendMessage(jid, { text: '⚠️ O comando !ban só pode ser usado em grupos.' });
            return;
        }

        if (args.length === 0 || !args[0].startsWith('@')) {
            await sock.sendMessage(jid, { text: '❌ Uso correto: !ban @usuario' });
            return;
        }

        const targetUserId = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        console.log('Usuário alvo corrigido:', targetUserId);

        const senderRole = await getUserRoleFromDatabase(senderJid);
        const targetUserRole = await getUserRoleFromDatabase(targetUserId);

            console.log('ANTES DOS IFS');


        if (!senderRole) {
            await sock.sendMessage(jid, { text: '❌ Seu cargo não foi encontrado no sistema.' });

                    console.log('SENDER ROLE');

            return;
        }

        if (!isRoleAuthorized(senderRole, ['Capitão', 'General', 'Comandante', 'Imperador', 'Dono'], targetUserRole)) {
            await sock.sendMessage(jid, { text: '❌ Você não tem permissão para banir este usuário.' });


                                console.log('ROLE AUTORIZED');

            return;
        }

        const groupParticipants = await getAllGroupParticipants(jid);
        if (!groupParticipants.includes(targetUserId)) {
            await sock.sendMessage(jid, { text: '❌ Este usuário não está no grupo.' });

                                console.log('GROUP PARTICIPANTS');

            return;
        }

        console.log('Participantes do grupo:', await getAllGroupParticipants(jid));
    console.log('Tentando remover:', targetUserId);


        await sock.groupParticipantsUpdate(jid, [targetUserId], 'remove');
        await sock.sendMessage(jid, { text: `✅ Usuário ${args[0]} removido com sucesso.` });

    } catch (err) {
        console.error('Erro no comando !ban:', err);
        await sock.sendMessage(jid, { text: '❌ Erro ao tentar banir o usuário.' });
    }
    break;












case '!addcargo':
    try {
        if (args.length < 2 || !args[0].startsWith('@')) {
            await sock.sendMessage(jid, { text: 'Uso correto: !addcargo @usuario <cargo>' });
            break;
        }

        const targetUserIdAdd = args[0].slice(1) + '@s.whatsapp.net';
        const newRole = args[1].charAt(0).toUpperCase() + args[1].slice(1).toLowerCase();
        const senderRoleAdd = await getUserRoleFromDatabase(senderJid);
        const targetUserRoleAdd = await getUserRoleFromDatabase(targetUserIdAdd);

        if (!Object.values(roles).includes(newRole)) {
            await sock.sendMessage(jid, { text: `⚠️ Cargo "${newRole}" não existe.` });
            break;
        }

        const allowedRolesAdd = ['Capitão', 'General', 'Comandante', 'Imperador', 'Dono'];
        const canGiveRole =
            roleHierarchy.indexOf(senderRoleAdd) > roleHierarchy.indexOf(newRole) &&
            (targetUserRoleAdd === undefined || roleHierarchy.indexOf(senderRoleAdd) > roleHierarchy.indexOf(targetUserRoleAdd));

        if (!isRoleAuthorized(senderRoleAdd, allowedRolesAdd, targetUserRoleAdd) || !canGiveRole) {
            await sock.sendMessage(jid, { text: '❌ Você não tem permissão para atribuir este cargo.' });
            break;
        }

        await dbClient.query(
            'INSERT INTO users (user_id, number, role, last_rank_date, rank_giver_id) VALUES ($1, $2, $3, NOW(), $4) ON CONFLICT (user_id) DO UPDATE SET role = $3, last_rank_date = NOW(), rank_giver_id = $4',
            [targetUserIdAdd, targetUserIdAdd.split('@')[0], newRole, senderJid]
        );

        await sock.sendMessage(jid, { text: `✅ Cargo "${newRole}" atribuído a ${args[0]}.` });
    } catch (error) {
        console.error('Erro no comando !addcargo:', error);
        await sock.sendMessage(jid, { text: '❌ Erro ao tentar atribuir o cargo.' });
    }
    break;

case '!removecargo':
    try {
        if (!args[0]?.startsWith('@')) {
            await sock.sendMessage(jid, { text: 'Uso correto: !removecargo @usuario' });
            break;
        }

        const targetUserIdRemove = args[0].slice(1) + '@s.whatsapp.net';
        const senderRoleRemove = await getUserRoleFromDatabase(senderJid);
        const targetUserRoleRemove = await getUserRoleFromDatabase(targetUserIdRemove);

        if (
            isRoleAuthorized(senderRoleRemove, ['Capitão', 'General', 'Comandante', 'Imperador', 'Dono'], targetUserRoleRemove) &&
            senderRoleRemove !== targetUserRoleRemove
        ) {
            await dbClient.query(
                'UPDATE users SET role = NULL WHERE user_id = $1',
                [targetUserIdRemove]
            );
            await sock.sendMessage(jid, { text: `✅ Cargo removido de ${args[0]}.` });
        } else {
            await sock.sendMessage(jid, { text: '❌ Você não tem permissão para remover o cargo deste usuário.' });
        }
    } catch (error) {
        console.error('Erro no comando !removecargo:', error);
        await sock.sendMessage(jid, { text: '❌ Falha ao tentar remover o cargo.' });
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

case '!listarcargos':
    try {
        const results = await dbClient.query('SELECT user_id, role FROM users WHERE role IS NOT NULL AND role != $1 ORDER BY role', ['Dono']);

        if (results.rows.length > 0) {
            let listaCargos = '📜 *Lista de Usuários com Cargos:* 📜\n\n';
            const mentions = [];

            for (const row of results.rows) {
                const userId = row.user_id;
                const role = row.role;
                const userName = userId.split('@')[0];
                mentions.push(userId);
                listaCargos += `- @${userName}: *${role}*\n`;
            }

            await sock.sendMessage(jid, { text: listaCargos.trim(), mentions });
        } else {
            await reply({ text: 'ℹ️ Nenhum usuário possui um cargo definido.' });
        }
    } catch (error) {
        console.error('Erro ao listar cargos:', error);
        await reply({ text: '❌ Falha ao listar os cargos.' });
    }
    break;

case '!ranks':
    try {
        const textoRanks = `📜 *CARGOS & HIERARQUIA* 📜

🔹 *Recruta*
Comandos: !ping, !perdi, !menosuma, !dado, !s
Sem permissões administrativas

🔸 *Capitão*
Comandos: !all, !sorteio
Pode usar !listarcargos

🔸 *General*
Pode usar !ban
Pode promover até Capitão
Pode usar !removecargo

🔸 *Comandante*
Pode promover até General
Acesso total aos comandos administrativos

🔸 *Imperador*
Pode promover até Comandante
Controle total sobre o sistema de patentes
Pode usar !bloquear

Use !cargo para ver seu nível atual`;

        await reply({ text: textoRanks });
    } catch (error) {
        console.error('Erro ao exibir ranks:', error);
        await reply({ text: '❌ Não foi possível exibir os ranks no momento.' });
    }
    break;

case '!bloquear':
    try {
        if (!jid.endsWith('@g.us') && !isPrivate) {
            await reply({ text: '⚠️ Este comando só pode ser usado em grupos ou no privado.' });
            return;
        }

        if (!args[0]?.startsWith('@')) {
            await reply({ text: '⚠️ Uso correto: !bloquear @usuario' });
            return;
        }

        const targetUserIdBlock = args[0].slice(1) + '@s.whatsapp.net';
        const senderRoleBlock = await getUserRoleFromDatabase(senderJid);

        if (isRoleAuthorized(senderRoleBlock, ['General', 'Comandante', 'Imperador', 'Dono'])) {
            const result = await dbClient.query(
                'UPDATE users SET is_blocked = NOT COALESCE(is_blocked, FALSE) WHERE user_id = $1 RETURNING is_blocked',
                [targetUserIdBlock]
            );

            const estadoAtual = result.rows[0]?.is_blocked;
            const statusMsg = estadoAtual ? 'bloqueado' : 'desbloqueado';
            await reply({ text: `✅ Usuário ${args[0]} ${statusMsg}.` });
        } else {
            await reply({ text: '❌ Você não tem permissão para alterar o bloqueio de usuários.' });
        }
    } catch (error) {
        console.error('Erro no comando !bloquear:', error);
        await reply({ text: '❌ Ocorreu um erro ao tentar atualizar o estado de bloqueio.' });
    }
    break;

case '!cargo':
    try {
        const result = await dbClient.query(
            'SELECT role, last_rank_date, rank_giver_id FROM users WHERE user_id = $1',
            [senderJid]
        );

        if (result.rows.length === 0 || !result.rows[0].role) {
            await reply({ text: '🏷️ Você ainda não possui um cargo atribuído.' });
            return;
        }

        const { role, last_rank_date, rank_giver_id } = result.rows[0];
        let mensagem = `🏷️ *Seu Cargo Atual:*\n- Cargo: *${role}*`;

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
    } catch (error) {
        console.error('Erro no comando !cargo:', error);
        await reply({ text: '❌ Não foi possível recuperar seu cargo no momento.' });
    }
    break;




                    default:
                        console.log(`Comando desconhecido: ${command}`);
                        await sock.sendMessage(jid, { text: 'Comando desconhecido. Use !help para ver os comandos disponíveis.' });
                        break;
                }
            } else if (isPrivate && text) {
                const now = Date.now();
                if (!privateFloodCooldown[jid] || now - privateFloodCooldown[jid] > FLOOD_COOLDOWN_TIME_MS) {
                    await sock.sendMessage(jid, { text: '🤖 Este é um robô. Use comandos iniciados com "!" (ex: !help).' });
                    privateFloodCooldown[jid] = now;
                }
           } /* else {
                if (jid.endsWith('@g.us') && text) {
                    console.log('Mensagem de grupo:', text);
                }
            }*/
        }
    });
    // FIM DO HANDLER DE MENSAGENS (MESSAGES.UPSERT)

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

connectToWhatsApp();