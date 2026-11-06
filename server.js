const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// إعدادات الأدوار وخصائصها
const ROLES_INFO = {
    boss: {
        name: 'الريس (زعيم العصابة)',
        team: 'mafia',
        desc: 'تختار ضحية الليل وقرارك يطغى على العصابة. إذا فحصك شيخ القرية تظهر له كشخص بريء!'
    },
    mafia: {
        name: 'فرد عصابة',
        team: 'mafia',
        desc: 'تصوت ليلاً مع العصابة لاغتيال أحد أهل القرية، وتشارك في الشات السري ليلاً.'
    },
    silencer: {
        name: 'الساكت',
        team: 'mafia',
        desc: 'عضو في العصابة. تختار لاعباً ليلاً لتمنعه من الكلام في الشات العام طوال النهار التالي.'
    },
    seer: {
        name: 'شيخ القرية',
        team: 'village',
        desc: 'تفحص لاعباً واحداً كل ليلة لتعرف ما إذا كان من العصابة أم بريئاً (احذر: الريس يظهر كبريء).'
    },
    doctor: {
        name: 'الطبيب',
        team: 'village',
        desc: 'تحمي لاعباً واحداً كل ليلة من القتل (لا يمكنك حماية نفس الشخص ليلتين متتاليتين).'
    },
    sniper: {
        name: 'القناص',
        team: 'village',
        desc: 'تمتلك طلقة واحدة فقط طوال اللعبة، يمكنك استخدامها ليلاً لاغتيال من تشك فيه.'
    },
    villager: {
        name: 'مواطن (أهل القرية)',
        team: 'village',
        desc: 'لا تملك قدرة ليلية. سلاحك هو ذكاؤك، تحليل النقاشات، والتصويت في النهار لكشف العصابة.'
    }
};

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return rooms[code] ? generateRoomCode() : code;
}

function assignRoles(count) {
    let pool = [];
    if (count <= 6) {
        pool = ['boss', 'doctor', 'seer'];
    } else if (count <= 8) {
        pool = ['boss', 'mafia', 'doctor', 'seer', 'silencer'];
    } else {
        pool = ['boss', 'mafia', 'silencer', 'doctor', 'seer', 'sniper'];
    }
    while (pool.length < count) {
        pool.push('villager');
    }
    // خلط الأدوار عشوائياً (Fisher-Yates Shuffle)
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
}

function getPublicPlayers(room) {
    return room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isAlive: p.isAlive,
        isMuted: p.isMuted,
        votesReceived: room.phase === 'VOTING' ? countVotesFor(room, p.id) : 0
    }));
}

function countVotesFor(room, targetId) {
    return Object.values(room.dayVotes).filter(v => v === targetId).length;
}

function broadcastRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const skipVotes = Object.values(room.dayVotes).filter(v => v === 'skip').length;

    room.players.forEach(p => {
        const mafiaTeamIds = room.players
            .filter(mp => mp.team === 'mafia')
            .map(mp => ({ id: mp.id, name: mp.name, roleName: ROLES_INFO[mp.role]?.name }));

        io.to(p.id).emit('roomState', {
            code: room.code,
            phase: room.phase,
            dayCount: room.dayCount,
            timer: room.timer,
            players: getPublicPlayers(room),
            skipVotes: skipVotes,
            skipDiscussCount: room.skipDiscussVotes.size,
            aliveCount: room.players.filter(ap => ap.isAlive).length,
            myInfo: {
                id: p.id,
                name: p.name,
                isHost: p.isHost,
                isAlive: p.isAlive,
                isMuted: p.isMuted,
                usedGesture: p.usedGesture,
                role: p.role,
                roleInfo: ROLES_INFO[p.role] || null,
                team: p.team,
                ammo: p.ammo,
                lastHealedId: p.lastHealedId,
                lastMutedId: p.lastMutedId,
                hasSubmittedNight: room.nightActions.submitted.has(p.id),
                mafiaTeammates: p.team === 'mafia' ? mafiaTeamIds : []
            }
        });
    });
}

function addGameLog(roomCode, message, type = 'system') {
    const room = rooms[roomCode];
    if (!room) return;
    const logItem = { time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }), message, type };
    room.logs.push(logItem);
    io.to(roomCode).emit('newLog', logItem);
}

function checkWinCondition(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase === 'LOBBY' || room.phase === 'GAME_OVER') return false;

    const aliveMafia = room.players.filter(p => p.isAlive && p.team === 'mafia').length;
    const aliveVillage = room.players.filter(p => p.isAlive && p.team === 'village').length;

    let winner = null;
    let reason = '';

    if (aliveMafia === 0) {
        winner = 'village';
        reason = 'تم القضاء على جميع أفراد العصابة بنجاح!';
    } else if (aliveMafia >= aliveVillage) {
        winner = 'mafia';
        reason = 'تساوى عدد العصابة مع أهل القرية وسيطروا على التصويت!';
    }

    if (winner) {
        clearInterval(room.interval);
        room.phase = 'GAME_OVER';
        const fullReveal = room.players.map(p => ({
            name: p.name,
            roleName: ROLES_INFO[p.role].name,
            team: p.team,
            isAlive: p.isAlive
        }));
        addGameLog(roomCode, `انتهت اللعبة! الفائز: ${winner === 'village' ? 'أهل القرية' : 'العصابة'} - ${reason}`, 'important');
        broadcastRoomState(roomCode);
        io.to(roomCode).emit('gameOver', { winner, reason, players: fullReveal });
        return true;
    }
    return false;
}

function startPhase(roomCode, phase, duration) {
    const room = rooms[roomCode];
    if (!room) return;

    clearInterval(room.interval);
    room.phase = phase;
    room.timer = duration;

    if (phase === 'NIGHT') {
        room.dayCount++;
        room.nightActions = {
            bossTarget: null,
            mafiaVotes: {},
            doctorTarget: null,
            seerTarget: null,
            sniperTarget: null,
            silencerTarget: null,
            submitted: new Set()
        };
        // إعادة ضبط كتم الصوت من اليوم السابق
        room.players.forEach(p => {
            p.isMuted = false;
            p.usedGesture = false;
        });
        addGameLog(roomCode, `🌙 حلّ الليل (${room.dayCount}).. القرية تغط في نوم عميق وأصحاب القدرات يستيقظون.`, 'phase');
    } else if (phase === 'DISCUSSION') {
        room.skipDiscussVotes = new Set();
        addGameLog(roomCode, `☀️ بدأ النقاش النهاري.. لديكم ${duration} ثانية لكشف الخونة.`, 'phase');
    } else if (phase === 'VOTING') {
        room.dayVotes = {};
        addGameLog(roomCode, `⚖️ بدأت مرحلة التصويت.. اختاروا من تشكون فيه لإعدامه أو تخطوا التصويت.`, 'phase');
    }

    broadcastRoomState(roomCode);

    room.interval = setInterval(() => {
        room.timer--;
        io.to(roomCode).emit('timerTick', room.timer);

        if (room.timer <= 0) {
            clearInterval(room.interval);
            handlePhaseTransition(roomCode);
        }
    }, 1000);
}

function handlePhaseTransition(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.phase === 'ROLE_REVEAL') {
        startPhase(roomCode, 'NIGHT', 40);
    } else if (room.phase === 'NIGHT') {
        resolveNight(roomCode);
    } else if (room.phase === 'MORNING_ANNOUNCEMENT') {
        if (!checkWinCondition(roomCode)) {
            startPhase(roomCode, 'DISCUSSION', 90);
        }
    } else if (room.phase === 'DISCUSSION') {
        startPhase(roomCode, 'VOTING', 30);
    } else if (room.phase === 'VOTING') {
        resolveVoting(roomCode);
    }
}

function checkAllNightActionsSubmitted(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'NIGHT') return;

    const activePlayers = room.players.filter(p => p.isAlive && p.role !== 'villager');
    const allSubmitted = activePlayers.every(p => room.nightActions.submitted.has(p.id));

    if (allSubmitted && activePlayers.length > 0) {
        clearInterval(room.interval);
        setTimeout(() => resolveNight(roomCode), 1000);
    }
}

function resolveNight(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const actions = room.nightActions;

    // 1. تحديد ضحية العصابة (قرار الريس يطغى، وإلا الأغلبية)
    let mafiaVictimId = actions.bossTarget;
    if (!mafiaVictimId) {
        const counts = {};
        Object.values(actions.mafiaVotes).forEach(targetId => {
            counts[targetId] = (counts[targetId] || 0) + 1;
        });
        let maxVotes = 0;
        Object.entries(counts).forEach(([id, c]) => {
            if (c > maxVotes) {
                maxVotes = c;
                mafiaVictimId = id;
            }
        });
    }

    // 2. تسجيل حماية الطبيب
    const healedId = actions.doctorTarget;
    const doctor = room.players.find(p => p.isAlive && p.role === 'doctor');
    if (doctor && healedId) {
        doctor.lastHealedId = healedId;
    }

    // 3. حساب القتلى
    const killedIds = new Set();
    if (mafiaVictimId && mafiaVictimId !== healedId) {
        killedIds.add(mafiaVictimId);
    }

    const sniper = room.players.find(p => p.isAlive && p.role === 'sniper');
    if (sniper && actions.sniperTarget && sniper.ammo > 0) {
        sniper.ammo = 0;
        if (actions.sniperTarget !== healedId) {
            killedIds.add(actions.sniperTarget);
        }
    }

    // تطبيق الموت
    const deadNames = [];
    killedIds.forEach(id => {
        const victim = room.players.find(p => p.id === id);
        if (victim && victim.isAlive) {
            victim.isAlive = false;
            deadNames.push(victim.name);
        }
    });

    // 4. تطبيق قدرة الساكت
    let mutedName = null;
    const silencer = room.players.find(p => p.isAlive && p.role === 'silencer');
    if (silencer && actions.silencerTarget) {
        silencer.lastMutedId = actions.silencerTarget;
        const mutedPlayer = room.players.find(p => p.id === actions.silencerTarget);
        if (mutedPlayer && mutedPlayer.isAlive) {
            mutedPlayer.isMuted = true;
            mutedName = mutedPlayer.name;
        }
    }

    // 5. إرسال نتيجة الفحص لشيخ القرية
    const seer = room.players.find(p => p.isAlive && p.role === 'seer');
    if (seer && actions.seerTarget) {
        const target = room.players.find(p => p.id === actions.seerTarget);
        if (target) {
            // الريس يظهر كبريء لشيخ القرية
            const isGuilty = (target.team === 'mafia' && target.role !== 'boss');
            const resultText = isGuilty ? 'عصابة 😈' : 'بريء 😇';
            io.to(seer.id).emit('seerResult', {
                targetName: target.name,
                result: resultText,
                isGuilty
            });
        }
    }

    // صياغة إعلان الصباح
    let morningReport = '';
    if (deadNames.length === 0) {
        morningReport = '🌅 أشرقت الشمس.. مرت الليلة بسلام ولم يُقتل أحد!';
    } else {
        morningReport = `🌅 أشرقت الشمس على فاجعة.. تم اغتيال: ( ${deadNames.join(' ، ')} ) في الظلام!`;
    }

    if (mutedName) {
        morningReport += ` كما استيقظ ( ${mutedName} ) ليجد نفسه ممنوعاً من الكلام اليوم بأمر الساكت 🤐!`;
    }

    addGameLog(roomCode, morningReport, 'important');
    io.to(roomCode).emit('morningModal', morningReport);

    startPhase(roomCode, 'MORNING_ANNOUNCEMENT', 8);
}

function resolveVoting(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const counts = { skip: 0 };
    Object.values(room.dayVotes).forEach(targetId => {
        counts[targetId] = (counts[targetId] || 0) + 1;
    });

    let topTarget = null;
    let maxVotes = 0;
    let isTie = false;

    Object.entries(counts).forEach(([id, c]) => {
        if (id === 'skip') return;
        if (c > maxVotes) {
            maxVotes = c;
            topTarget = id;
            isTie = false;
        } else if (c === maxVotes && maxVotes > 0) {
            isTie = true;
        }
    });

    let voteResultMsg = '';
    if (!topTarget || maxVotes <= counts.skip || isTie) {
        voteResultMsg = '⚖️ انتهى التصويت بتعادل أو أغلبية التخطي.. لم يتم إعدام أحد اليوم!';
        addGameLog(roomCode, voteResultMsg, 'system');
    } else {
        const executed = room.players.find(p => p.id === topTarget);
        if (executed) {
            executed.isAlive = false;
            voteResultMsg = `⚖️ قرر أهل القرية إعدام ( ${executed.name} )! وكانت هويته: [ ${ROLES_INFO[executed.role].name} ]`;
            addGameLog(roomCode, voteResultMsg, 'important');
        }
    }

    io.to(roomCode).emit('morningModal', voteResultMsg);

    if (!checkWinCondition(roomCode)) {
        setTimeout(() => {
            if (rooms[roomCode] && rooms[roomCode].phase !== 'GAME_OVER') {
                startPhase(roomCode, 'NIGHT', 40);
            }
        }, 5000);
    }
}

io.on('connection', (socket) => {
    // إنشاء غرفة
    socket.on('createRoom', ({ playerName }) => {
        const name = (playerName || '').trim().substring(0, 18);
        if (!name) return socket.emit('errorMsg', 'يرجى إدخال اسم صحيح.');

        const code = generateRoomCode();
        rooms[code] = {
            code,
            phase: 'LOBBY',
            dayCount: 0,
            timer: 0,
            interval: null,
            players: [{
                id: socket.id,
                name,
                isHost: true,
                role: null,
                team: null,
                isAlive: true,
                isMuted: false,
                usedGesture: false,
                ammo: 0,
                lastHealedId: null,
                lastMutedId: null
            }],
            nightActions: { submitted: new Set() },
            dayVotes: {},
            skipDiscussVotes: new Set(),
            logs: []
        };

        socket.join(code);
        socket.roomCode = code;
        addGameLog(code, `تم إنشاء الغرفة بواسطة ${name}.`, 'system');
        broadcastRoomState(code);
    });

    // انضمام لغرفة
    socket.on('joinRoom', ({ playerName, roomCode }) => {
        const name = (playerName || '').trim().substring(0, 18);
        const code = (roomCode || '').trim().toUpperCase();

        if (!name || !code) return socket.emit('errorMsg', 'يرجى إدخال الاسم وكود الغرفة.');
        const room = rooms[code];
        if (!room) return socket.emit('errorMsg', 'كود الغرفة غير صحيح أو الغرفة غير موجودة.');
        if (room.phase !== 'LOBBY') return socket.emit('errorMsg', 'اللعبة بدأت بالفعل في هذه الغرفة!');
        if (room.players.some(p => p.name === name)) return socket.emit('errorMsg', 'هذا الاسم مستخدم بالفعل داخل الغرفة.');

        room.players.push({
            id: socket.id,
            name,
            isHost: false,
            role: null,
            team: null,
            isAlive: true,
            isMuted: false,
            usedGesture: false,
            ammo: 0,
            lastHealedId: null,
            lastMutedId: null
        });

        socket.join(code);
        socket.roomCode = code;
        addGameLog(code, `انضم ${name} إلى القرية.`, 'system');
        broadcastRoomState(code);
    });

    // بدء اللعبة
    socket.on('startGame', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.phase !== 'LOBBY') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return;

        if (room.players.length < 5) {
            return socket.emit('errorMsg', 'يجب وجود 5 لاعبين على الأقل لبدء اللعبة!');
        }

        const assignedRoles = assignRoles(room.players.length);
        room.dayCount = 0;

        room.players.forEach((p, idx) => {
            const roleKey = assignedRoles[idx];
            p.role = roleKey;
            p.team = ROLES_INFO[roleKey].team;
            p.isAlive = true;
            p.isMuted = false;
            p.usedGesture = false;
            p.ammo = roleKey === 'sniper' ? 1 : 0;
            p.lastHealedId = null;
            p.lastMutedId = null;
        });

        addGameLog(room.code, '🔔 تم توزيع الأدوار سراً.. تفقد بطاقتك الآن!', 'important');
        startPhase(room.code, 'ROLE_REVEAL', 10);
    });

    // تنفيذ قدرة ليلية
    socket.on('nightAction', ({ targetId }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.phase !== 'NIGHT') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive) return;

        if (player.role === 'boss') {
            room.nightActions.bossTarget = targetId;
            room.nightActions.mafiaVotes[player.id] = targetId;
            io.to(room.code).emit('mafiaActionNotice', { actor: player.name, role: 'الريس', targetId });
        } else if (player.role === 'mafia') {
            room.nightActions.mafiaVotes[player.id] = targetId;
        } else if (player.role === 'silencer') {
            if (targetId === player.lastMutedId) {
                return socket.emit('errorMsg', 'لا يمكنك إسكات نفس اللاعب ليلتين متتاليتين!');
            }
            room.nightActions.silencerTarget = targetId;
        } else if (player.role === 'doctor') {
            if (targetId === player.lastHealedId) {
                return socket.emit('errorMsg', 'لا يمكنك حماية نفس اللاعب ليلتين متتاليتين!');
            }
            room.nightActions.doctorTarget = targetId;
        } else if (player.role === 'seer') {
            room.nightActions.seerTarget = targetId;
        } else if (player.role === 'sniper') {
            if (targetId && player.ammo <= 0) {
                return socket.emit('errorMsg', 'لقد استنفدت طلقتك الوحيدة بالفعل!');
            }
            room.nightActions.sniperTarget = targetId; // يمكن أن يكون null إذا اختار تخطي القنص
        }

        room.nightActions.submitted.add(player.id);
        broadcastRoomState(room.code);
        checkAllNightActionsSubmitted(room.code);
    });

    // الشات العام والشات السري للعصابة
    socket.on('sendMessage', ({ text, channel }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive) return;

        const cleanText = (text || '').trim().substring(0, 200);
        if (!cleanText) return;

        // شات العصابة ليلاً
        if (channel === 'mafia' && room.phase === 'NIGHT' && player.team === 'mafia') {
            room.players.filter(p => p.team === 'mafia').forEach(mp => {
                io.to(mp.id).emit('chatMessage', {
                    sender: player.name,
                    text: cleanText,
                    channel: 'mafia'
                });
            });
            return;
        }

        // الشات العام نهاراً
        if (room.phase === 'DISCUSSION' || room.phase === 'VOTING') {
            if (player.isMuted) {
                return socket.emit('errorMsg', 'أنت ممنوع من الكلام هذا اليوم بأمر الساكت!');
            }
            io.to(room.code).emit('chatMessage', {
                sender: player.name,
                text: cleanText,
                channel: 'public'
            });
        }
    });

    // إيماءة اللاعب المسكت (مرة واحدة في اليوم)
    socket.on('sendMutedGesture', ({ gestureText }) => {
        const room = rooms[socket.roomCode];
        if (!room || (room.phase !== 'DISCUSSION' && room.phase !== 'VOTING')) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive || !player.isMuted || player.usedGesture) return;

        player.usedGesture = true;
        io.to(room.code).emit('chatMessage', {
            sender: `${player.name} (إشارة صامتة 🤐)`,
            text: gestureText,
            channel: 'gesture'
        });
        broadcastRoomState(room.code);
    });

    // تصويت تخطي النقاش
    socket.on('voteSkipDiscussion', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.phase !== 'DISCUSSION') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive) return;

        room.skipDiscussVotes.add(player.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;

        broadcastRoomState(room.code);

        if (room.skipDiscussVotes.size > Math.floor(aliveCount / 2)) {
            addGameLog(room.code, 'اتفق أغلبية الأحياء على إنهاء النقاش والانتقال للتصويت فوراً.', 'system');
            clearInterval(room.interval);
            startPhase(room.code, 'VOTING', 30);
        }
    });

    // التصويت النهاري للإعدام
    socket.on('dayVote', ({ targetId }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.phase !== 'VOTING') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive) return;

        room.dayVotes[player.id] = targetId;
        broadcastRoomState(room.code);

        const aliveCount = room.players.filter(p => p.isAlive).length;
        if (Object.keys(room.dayVotes).length >= aliveCount) {
            clearInterval(room.interval);
            setTimeout(() => resolveVoting(room.code), 800);
        }
    });

    // إعادة اللعب في نفس الغرفة
    socket.on('restartLobby', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) return;

        clearInterval(room.interval);
        room.phase = 'LOBBY';
        room.dayCount = 0;
        room.players.forEach(p => {
            p.role = null;
            p.team = null;
            p.isAlive = true;
            p.isMuted = false;
            p.usedGesture = false;
        });
        addGameLog(room.code, '🔄 أعاد مدير الغرفة الجميع إلى ردهة الانتظار لجولة جديدة.', 'system');
        broadcastRoomState(room.code);
    });

    // معالجة الخروج أو انقطاع الاتصال
    socket.on('disconnect', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const idx = room.players.findIndex(p => p.id === socket.id);
        if (idx === -1) return;

        const leavingPlayer = room.players[idx];

        if (room.phase === 'LOBBY') {
            room.players.splice(idx, 1);
            if (room.players.length === 0) {
                clearInterval(room.interval);
                delete rooms[code];
                return;
            }
            if (leavingPlayer.isHost) {
                room.players[0].isHost = true;
            }
            addGameLog(code, `غادر ${leavingPlayer.name} الغرفة.`, 'system');
            broadcastRoomState(code);
        } else {
            leavingPlayer.isAlive = false;
            if (leavingPlayer.isHost) {
                const nextHost = room.players.find(p => p.id !== socket.id);
                if (nextHost) nextHost.isHost = true;
            }
            addGameLog(code, `⚠️ انقطع اتصال ${leavingPlayer.name} وتم اعتباره خارج اللعبة.`, 'important');
            if (!checkWinCondition(code)) {
                broadcastRoomState(code);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
