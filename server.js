'use strict';
/* 欢乐斗牛 · 联机版服务器（Node.js + Socket.IO）
   - 同一 WiFi：朋友手机扫码/输地址即进
   - 房间号创建/加入，最多 8 人，空位用 AI 补齐
   - 权威服务器：发牌/抢庄/道具/下注/亮牌/结算 全在服务端计算，防作弊
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const BASE_BET = 100;
const START_COINS = 10000;
const MAX_SEATS = 8;
const ACTION_TIMEOUT_MS = 20000;
const SPECIAL_ROUND_INTERVAL = 20;
const REVEAL_DELAY_MS = 1350;
const BANKER_REVEAL_DELAY_MS = 1800;

/* ---------------- 静态文件服务 ---------------- */
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC, path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});
const io = new Server(server, { cors: { origin: '*' } });

/* ---------------- 局域网 IP ---------------- */
function getLanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  // 优先 192.168.* > 172.* > 10.* > 其它
  out.sort((a, b) => rank(a) - rank(b));
  function rank(ip){ if(ip.startsWith('192.168.'))return 0; if(ip.startsWith('172.'))return 1; if(ip.startsWith('10.'))return 2; return 3; }
  return out.length ? out : ['localhost'];
}
const LAN_IP = getLanIps()[0];

/* ================= 斗牛核心算法（与单机版一致，已验证） ================= */
const SUITS = ['♠','♥','♣','♦'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUIT_ORDER = { '♦':0, '♣':1, '♥':2, '♠':3 };
const RANK_ORDER = { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13 };
const COMBOS3 = [[0,1,2],[0,1,3],[0,1,4],[0,2,3],[0,2,4],[0,3,4],[1,2,3],[1,2,4],[1,3,4],[2,3,4]];

function cardPoint(r){ if(r==='A')return 1; if(r==='10'||r==='J'||r==='Q'||r==='K')return 10; return parseInt(r,10); }
function cardKey(c){ return RANK_ORDER[c.rank]*10 + SUIT_ORDER[c.suit]; }
function createDeck(){ const d=[]; for(const s of SUITS) for(const r of RANKS) d.push({suit:s,rank:r}); return d; }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

function evaluateHand(cards){
  const pts = cards.map(c => cardPoint(c.rank));
  const total = pts.reduce((a,b)=>a+b,0);
  if (pts.every(p=>p<=5) && total<=10) return { rankType:12, name:'五小牛', multiplier:5, niuIdx:[0,1,2,3,4], valIdx:[], cls:'great' };
  if (cards.every(c=>c.rank==='J'||c.rank==='Q'||c.rank==='K')) return { rankType:11, name:'五花牛', multiplier:4, niuIdx:[0,1,2,3,4], valIdx:[], cls:'great' };
  for (const c of COMBOS3){
    if ((pts[c[0]]+pts[c[1]]+pts[c[2]])%10===0){
      const rest=[0,1,2,3,4].filter(i=>!c.includes(i));
      let v=(pts[rest[0]]+pts[rest[1]])%10;
      if (v===0) return { rankType:10, name:'牛牛', multiplier:3, niuIdx:c, valIdx:rest, cls:'great' };
      return { rankType:v, name:'牛'+v, multiplier:(v>=7?2:1), niuIdx:c, valIdx:rest, cls:(v>=7?'good':'') };
    }
  }
  return { rankType:0, name:'没牛', multiplier:1, niuIdx:[], valIdx:[], cls:'none' };
}
function maxCardKey(cards){ let b=-1; for(const c of cards){ const k=cardKey(c); if(k>b)b=k; } return b; }
function compareHands(a, b){ if(a.hand.rankType!==b.hand.rankType) return a.hand.rankType-b.hand.rankType; return maxCardKey(a.cards)-maxCardKey(b.cards); }

function aiGrabLevel(h){ let b; if(h.rankType>=10)b=4; else if(h.rankType>=8)b=3; else if(h.rankType>=6)b=2; else if(h.rankType>=3)b=1; else b=0; const r=Math.random(); if(r<0.2&&b>0)b--; else if(r>0.85&&b<4)b++; return b; }
function aiBetLevel(h){ let b; if(h.rankType>=10)b=4; else if(h.rankType>=7)b=3; else if(h.rankType>=4)b=2; else b=1; const r=Math.random(); if(r<0.25&&b>1)b--; else if(r>0.85&&b<4)b++; return b; }

/* ================= 房间与玩家 ================= */
const BOT_NAMES = ['阿强','小美','老李','旺财','大黄','阿珍','虎子','铁蛋'];
const BOT_AVATARS = ['🤖','🐱','🐷','🐶','🦊','🐰','🐯','🐮'];
const HUMAN_AVATARS = ['😎','😀','🥳','😏','🤠','😺','🦁','👍'];
const rooms = {};   // code -> room
const socketRoom = {};  // socketId -> code
const delay = ms => new Promise(r => setTimeout(r, ms));

function genCode(){ let c; do { c=''; for(let i=0;i<4;i++) c+='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]; } while(rooms[c]); return c; }
function cleanName(n){ return String(n||'玩家').replace(/[<>]/g,'').trim().slice(0,8) || '玩家'; }
function firstHeaderValue(v){ return String(Array.isArray(v)?v[0]:(v||'')).split(',')[0].trim(); }
function publicOrigin(socket){
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/,'');
  const h = socket && socket.handshake && socket.handshake.headers ? socket.handshake.headers : {};
  const host = firstHeaderValue(h['x-forwarded-host'] || h.host);
  if (!host) return `http://${LAN_IP}:${PORT}`;
  const proto = firstHeaderValue(h['x-forwarded-proto']) || (host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function makeHumanPlayer(socketId, name){
  return { id:socketId, isBot:false, connected:true, name:cleanName(name), avatar:'😎',
           coins:START_COINS, props:{swap:3, double:2},
           cards:[], hand:null, grabLevel:0, betLevel:1, revealed:false, roundDelta:0, usedDouble:false,
           bankrupt:false, specialDouble:false };
}
function makeBot(idx){
  return { id:'bot_'+idx+'_'+Math.random().toString(36).slice(2,6), isBot:true, connected:true,
           name:BOT_NAMES[idx%BOT_NAMES.length], avatar:BOT_AVATARS[idx%BOT_AVATARS.length],
           coins:START_COINS, props:{swap:0, double:0},
           cards:[], hand:null, grabLevel:0, betLevel:1, revealed:false, roundDelta:0, usedDouble:false,
           bankrupt:false, specialDouble:false };
}
async function makeRoom(hostSocketId, name, seats, socket){
  const code = genCode();
  const joinUrl = `${publicOrigin(socket)}/?room=${code}`;
  let qr = '';
  try { qr = await QRCode.toDataURL(joinUrl, { margin:1, width:220 }); } catch(e){}
  const room = { code, hostId:hostSocketId, seatsTarget:Math.max(2,Math.min(MAX_SEATS,seats||6)),
                 started:false, phase:'lobby', message:'', round:0, bankerSeat:-1, revealSeat:-1,
                 deckRemain:[], pending:null, players:[], joinUrl, qr, loopRunning:false };
  const host = makeHumanPlayer(hostSocketId, name);
  host.avatar = HUMAN_AVATARS[0];
  room.players.push(host);
  rooms[code] = room;
  socketRoom[hostSocketId] = code;
  return room;
}
function humanCount(room){ return room.players.filter(p=>!p.isBot && p.connected).length; }
function humansPresent(room){ return room.players.some(p=>!p.isBot && p.connected); }
function activeHumanPresent(room){ return room.players.some(p=>!p.isBot && p.connected && !p.bankrupt && p.coins>0); }
function seatOfSocket(room, socketId){ return room.players.findIndex(p=>p.id===socketId); }

/* ================= 视图（发给客户端的状态） ================= */
function hideFifthCard(room){ return room.phase==='deal' || room.phase==='grab'; }
function visibleCards(room, p){
  if (!p.cards) return [];
  return hideFifthCard(room) ? p.cards.slice(0, 4) : p.cards;
}
function buildPrompt(room, seat){
  if (!room.pending || !room.pending.needed.has(seat)) return null;
  const pf = room.pending.promptFor;
  const p = room.players[seat];
  if (!p || p.bankrupt) return null;
  if (pf==='grab') return { type:'grab', options:[
    {label:'不抢',value:0},{label:'抢1倍',value:1},{label:'抢2倍',value:2},{label:'抢3倍',value:3},{label:'抢4倍',value:4}] };
  if (pf==='bet') return { type:'bet', options:[
    {label:'下注1倍',value:1},{label:'下注2倍',value:2},{label:'下注3倍',value:3},{label:'下注4倍',value:4}] };
  if (pf==='prop'){
    const opts=[{label:'不用道具',value:'none'}];
    if (p.props.double>0) opts.push({label:'✖️2 翻倍',value:'double'});
    if (p.props.swap>0) p.cards.forEach((c,i)=>opts.push({label:`换 ${c.rank}${c.suit}`, value:'swap:'+i}));
    return { type:'prop', options:opts };
  }
  return null;
}
function seatView(room, p, idx, mySeat){
  const showCards = p.revealed || idx===mySeat;
  const cards = visibleCards(room, p);
  return {
    seat: idx, name:p.name, avatar:p.avatar, isBot:p.isBot, connected:p.connected,
    coins:p.coins, isBanker: idx===room.bankerSeat, isMe: idx===mySeat,
    grabLevel:p.grabLevel, betLevel:p.betLevel, usedDouble:p.usedDouble,
    bankrupt:p.bankrupt, specialDouble:p.specialDouble,
    revealed:p.revealed, cardCount: cards.length,
    cards: showCards ? cards : null,
    niu: (p.revealed && p.hand) ? { name:p.hand.name, cls:p.hand.cls, niuIdx:p.hand.niuIdx, valIdx:p.hand.valIdx } : null,
    roundDelta: p.roundDelta,
    acted: room.pending ? !room.pending.needed.has(idx) : null,
  };
}
function lobbyView(room, mySeat){
  return { screen:'lobby', code:room.code, joinUrl:room.joinUrl, qr:room.qr,
    seatsTarget:room.seatsTarget, isHost: room.players[mySeat] && room.players[mySeat].id===room.hostId,
    mySeat,
    players: room.players.map((p,i)=>({ seat:i, name:p.name, avatar:p.avatar, isBot:p.isBot, connected:p.connected, isHost:p.id===room.hostId })),
  };
}
function gameView(room, mySeat){
  const me = room.players[mySeat];
  return { screen:'game', phase:room.phase, round:room.round, message:room.message,
    bankerSeat:room.bankerSeat, revealSeat:room.revealSeat, mySeat, seatsTarget:room.seatsTarget,
    deadline: room.pending ? room.pending.deadline : null,
    durationMs: room.pending ? room.pending.timeoutMs : null,
    prompt: buildPrompt(room, mySeat),
    isHost: me && me.id===room.hostId,
    you: me ? { cards:visibleCards(room, me), props:me.props, coins:me.coins, roundDelta:me.roundDelta, bankrupt:me.bankrupt } : null,
    seats: room.players.map((p,i)=>seatView(room,p,i,mySeat)),
  };
}
function broadcast(room){
  if (!room) return;
  for (const p of room.players){
    if (p.isBot || !p.connected) continue;
    const view = room.started ? gameView(room, room.players.indexOf(p)) : lobbyView(room, room.players.indexOf(p));
    io.to(p.id).emit('state', view);
  }
}

/* ================= 同时决策收集（带超时，AI 立即决策） ================= */
function botDecision(room, seat, pf){
  const p = room.players[seat];
  if (pf==='grab') return aiGrabLevel(p.hand);
  if (pf==='bet') return aiBetLevel(p.hand);
  return 'none';
}
function defaultDecision(pf){ if(pf==='grab')return 0; if(pf==='bet')return 1; return 'none'; }

function collect(room, seats, promptFor, timeoutMs){
  return new Promise(resolve => {
    const decisions = {}; const needed = new Set();
    for (const s of seats){
      const p = room.players[s];
      if (p.isBot || !p.connected) decisions[s] = botDecision(room, s, promptFor);
      else needed.add(s);
    }
    const finish = () => {
      if (!room.pending) return;
      clearTimeout(room.pending.timer);
      for (const s of room.pending.needed) if (!(s in decisions)) decisions[s] = defaultDecision(promptFor);
      room.pending = null;
      resolve(decisions);
    };
    room.pending = { promptFor, decisions, needed, deadline: Date.now()+timeoutMs, timeoutMs, finish };
    room.pending.timer = setTimeout(finish, timeoutMs);
    if (needed.size===0){ finish(); return; }
    broadcast(room);
  });
}
function onAction(room, seat, value){
  const pend = room.pending;
  if (!pend || !pend.needed.has(seat)) return;
  const pf = pend.promptFor;
  // 校验
  if (pf==='grab' && ![0,1,2,3,4].includes(value)) return;
  if (pf==='bet' && ![1,2,3,4].includes(value)) return;
  if (pf==='prop'){
    const p = room.players[seat];
    if (value!=='none' && value!=='double' && !(typeof value==='string' && value.startsWith('swap:'))) return;
    if (value==='double' && p.props.double<=0) return;
    if (typeof value==='string' && value.startsWith('swap:') && p.props.swap<=0) return;
  }
  pend.decisions[seat] = value;
  pend.needed.delete(seat);
  broadcast(room);
  if (pend.needed.size===0) pend.finish();
}

/* ================= 一局流程 ================= */
function allSeats(room){ return room.players.map((_,i)=>i); }
function isActivePlayer(p){ return p && !p.bankrupt && p.coins > 0; }
function activeSeats(room){ return room.players.map((p,i)=>isActivePlayer(p)?i:-1).filter(i=>i>=0); }
function cardOf(rank, suitIndex){ return { rank, suit:SUITS[suitIndex] }; }
function sameCard(a, b){ return a.rank===b.rank && a.suit===b.suit; }
function removeCards(deck, cards){
  for (const c of cards){
    const i = deck.findIndex(x=>sameCard(x, c));
    if (i>=0) deck.splice(i, 1);
  }
}
function specialHandCards(){
  if (Math.random() < 0.5) return [
    cardOf('A',0), cardOf('A',1), cardOf('2',2), cardOf('2',3), cardOf('3',0)
  ];
  return [
    cardOf('J',0), cardOf('Q',0), cardOf('K',0), cardOf('J',1), cardOf('Q',1)
  ];
}
function maybeApplySpecialRound(room, deck, seats){
  if (room.round % SPECIAL_ROUND_INTERVAL !== 0 || seats.length===0) return null;
  const seat = seats[Math.floor(Math.random()*seats.length)];
  const cards = specialHandCards();
  removeCards(deck, cards);
  const p = room.players[seat];
  p.cards = cards;
  p.hand = evaluateHand(cards);
  p.hand.multiplier *= 2;
  p.hand.name += '×2';
  p.specialDouble = true;
  return { seat, name:p.name, hand:p.hand.name };
}
function resetRound(room){
  for (const p of room.players){ p.cards=[]; p.hand=null; p.grabLevel=0; p.betLevel=1; p.revealed=false; p.roundDelta=0; p.usedDouble=false; p.specialDouble=false; }
  room.bankerSeat = -1;
  room.revealSeat = -1;
}
function determineBanker(room){
  const seats = activeSeats(room);
  const maxG = Math.max(...seats.map(s=>room.players[s].grabLevel));
  let cands;
  if (maxG===0) cands = seats;
  else cands = seats.filter(s=>room.players[s].grabLevel===maxG);
  room.bankerSeat = cands[Math.floor(Math.random()*cands.length)];
  if (maxG===0) room.players[room.bankerSeat].grabLevel = 1;
}
function applyProps(room, decisions){
  for (const s in decisions){
    const v = decisions[s]; const p = room.players[s];
    if (v==='double' && p.props.double>0){ p.props.double--; p.usedDouble=true; }
    else if (typeof v==='string' && v.startsWith('swap:') && p.props.swap>0 && room.deckRemain.length){
      const i = parseInt(v.slice(5),10);
      if (i>=0 && i<5){ p.cards[i] = room.deckRemain.pop(); p.hand = evaluateHand(p.cards); p.specialDouble=false; p.props.swap--; }
    }
  }
}
function settle(room){
  const banker = room.players[room.bankerSeat];
  let bankerTotal = 0;
  for (const s of activeSeats(room)){
    if (s===room.bankerSeat) continue;
    const pl = room.players[s];
    const plWins = compareHands(pl, banker) > 0;
    const winnerMult = plWins ? pl.hand.multiplier : banker.hand.multiplier;
    const factor = (pl.usedDouble?2:1) * (banker.usedDouble?2:1);
    let amount = BASE_BET * banker.grabLevel * pl.betLevel * winnerMult * factor;
    if (plWins) amount = Math.min(amount, Math.max(0, banker.coins + bankerTotal));
    else        amount = Math.min(amount, pl.coins);
    if (plWins){ pl.coins+=amount; pl.roundDelta+=amount; bankerTotal-=amount; }
    else       { pl.coins-=amount; pl.roundDelta-=amount; bankerTotal+=amount; }
  }
  banker.coins += bankerTotal; banker.roundDelta = bankerTotal;
  const busted = [];
  for (const p of room.players){
    if (!p.bankrupt && p.coins <= 0){
      p.coins = 0;
      p.bankrupt = true;
      busted.push(p.name);
    }
  }
  return busted;
}
function awardProps(room){
  for (const p of room.players){
    if (p.isBot || !p.connected || p.bankrupt) continue;
    if (p.roundDelta > 0){ if (Math.random()<0.5) p.props.swap++; else p.props.double++; }
  }
}

async function playRound(room){
  if (!room.started) return;
  const seatsNow = activeSeats(room);
  if (seatsNow.length < 2) return;
  room.round++;
  resetRound(room);
  // 发牌
  const deck = shuffle(createDeck());
  const seats = activeSeats(room);
  const special = maybeApplySpecialRound(room, deck, seats);
  for (const s of seats){
    const p = room.players[s];
    if (!p.cards.length){
      p.cards = deck.splice(0,5);
      p.hand = evaluateHand(p.cards);
    }
  }
  room.deckRemain = deck;
  room.phase='deal'; room.message=special ? `第${room.round}局特殊牌刷新：${special.hand}` : '发牌中…'; broadcast(room); await delay(1200);
  if (!room.started) return;

  // 抢庄（全体同时）
  room.phase='grab'; room.message='抢庄阶段：倍数高者坐庄'; broadcast(room);
  const grabs = await collect(room, activeSeats(room), 'grab', ACTION_TIMEOUT_MS);
  for (const s in grabs) room.players[s].grabLevel = grabs[s];
  determineBanker(room);
  room.phase='banker'; room.message = `${room.players[room.bankerSeat].name} 坐庄（${room.players[room.bankerSeat].grabLevel}倍）`;
  broadcast(room); await delay(1800);
  if (!room.started) return;

  // 道具（有道具的真人，同时；每局最多一个）
  const propSeats = activeSeats(room).filter(s=>{ const p=room.players[s]; return !p.isBot && p.connected && (p.props.swap>0||p.props.double>0); });
  if (propSeats.length){
    room.phase='prop'; room.message='道具阶段：可换牌或翻倍（每局限一个）'; broadcast(room);
    const propDecs = await collect(room, propSeats, 'prop', ACTION_TIMEOUT_MS);
    applyProps(room, propDecs);
    broadcast(room); await delay(700);
  }
  if (!room.started) return;

  // 下注（闲家同时）
  room.phase='bet'; room.message='下注阶段：闲家选择倍数'; broadcast(room);
  const betSeats = activeSeats(room).filter(s=>s!==room.bankerSeat);
  const bets = await collect(room, betSeats, 'bet', ACTION_TIMEOUT_MS);
  for (const s in bets) room.players[s].betLevel = bets[s];
  broadcast(room); await delay(800);
  if (!room.started) return;

  // 依次亮牌：从庄家下家开始，按座位顺序，庄家最后亮
  room.phase='reveal'; room.revealSeat=-1; room.message='依次亮牌 · 庄家最后';
  broadcast(room); await delay(500);
  if (!room.started) return;
  const revealOrder = [];
  for (let offset=1; offset<=room.players.length; offset++){
    const seat = (room.bankerSeat + offset) % room.players.length;
    if (isActivePlayer(room.players[seat])) revealOrder.push(seat);
  }
  for (const seat of revealOrder){
    const p = room.players[seat];
    room.revealSeat = seat;
    p.revealed = true;
    room.message = `${p.name} 亮牌 · ${p.hand.name}`;
    broadcast(room);
    await delay(seat===room.bankerSeat ? BANKER_REVEAL_DELAY_MS : REVEAL_DELAY_MS);
    if (!room.started) return;
  }
  room.revealSeat = -1;
  broadcast(room); await delay(500);
  if (!room.started) return;

  // 结算
  const busted = settle(room);
  awardProps(room);
  room.phase='settle'; room.revealSeat=-1;
  const me0 = room.players[room.bankerSeat];
  room.message = busted.length
    ? `本局结束 · ${busted.join('、')} 破产离场`
    : `本局结束 · 庄家 ${me0.name} ${me0.roundDelta>=0?'+':''}${me0.roundDelta}`;
  broadcast(room); await delay(4500);
}

async function gameLoop(room){
  if (room.loopRunning) return;
  room.loopRunning = true;
  try {
    while (room.started && activeSeats(room).length >= 2 && activeHumanPresent(room)){
      await playRound(room);
      if (!room.started) break;
      await delay(600);
    }
  } catch (e){ console.error('房间', room.code, '出错：', e); }
  room.loopRunning = false;
  if (room.started){ room.started=false; room.phase='lobby'; broadcast(room); }
}

function fillBots(room){
  let bi = 0;
  while (room.players.length < room.seatsTarget) room.players.push(makeBot(bi++));
}
function resetHumansForNewGame(room){
  for (const p of room.players){
    if (p.isBot) continue;
    p.coins = START_COINS;
    p.bankrupt = false;
    p.cards = [];
    p.hand = null;
    p.grabLevel = 0;
    p.betLevel = 1;
    p.revealed = false;
    p.roundDelta = 0;
    p.usedDouble = false;
    p.specialDouble = false;
  }
}
function destroyRoom(room){
  if (!room) return;
  if (room.pending){ clearTimeout(room.pending.timer); room.pending=null; }
  room.started = false;
  delete rooms[room.code];
}

/* ================= Socket 事件 ================= */
io.on('connection', (socket) => {
  socket.on('createRoom', async ({ name, seats }) => {
    const room = await makeRoom(socket.id, name, seats, socket);
    socket.join(room.code);
    socket.emit('joined', { code:room.code, mySeat:0, isHost:true });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = String(code||'').toUpperCase().trim();
    const room = rooms[code];
    if (!room){ socket.emit('errMsg', '房间不存在，检查房间号'); return; }
    if (room.started){ socket.emit('errMsg', '游戏已开始，等本局房主重开或换个房间'); return; }
    if (room.players.length >= MAX_SEATS){ socket.emit('errMsg', '房间已满（最多8人）'); return; }
    const p = makeHumanPlayer(socket.id, name);
    p.avatar = HUMAN_AVATARS[room.players.length % HUMAN_AVATARS.length];
    room.players.push(p);
    socketRoom[socket.id] = code;
    socket.join(code);
    socket.emit('joined', { code, mySeat: room.players.length-1, isHost:false });
    broadcast(room);
  });

  socket.on('setSeats', ({ seats }) => {
    const room = rooms[socketRoom[socket.id]]; if (!room || room.started) return;
    if (socket.id !== room.hostId) return;
    room.seatsTarget = Math.max(Math.max(2, humanCount(room)), Math.min(MAX_SEATS, seats|0));
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socketRoom[socket.id]]; if (!room || room.started) return;
    if (socket.id !== room.hostId) return;
    room.players = room.players.filter(p=>!p.isBot);
    resetHumansForNewGame(room);
    room.round = 0;
    room.seatsTarget = Math.max(room.seatsTarget, room.players.length);
    fillBots(room);
    room.started = true;
    broadcast(room);
    gameLoop(room);
  });

  socket.on('action', ({ value }) => {
    const room = rooms[socketRoom[socket.id]]; if (!room || !room.started) return;
    const seat = seatOfSocket(room, socket.id); if (seat<0) return;
    onAction(room, seat, value);
  });

  socket.on('backToLobby', () => {
    const room = rooms[socketRoom[socket.id]]; if (!room) return;
    if (socket.id !== room.hostId) return;
    room.started = false;
    if (room.pending){ clearTimeout(room.pending.timer); room.pending=null; }
    // 移除机器人，回到大厅
    room.players = room.players.filter(p=>!p.isBot);
    room.phase='lobby'; room.bankerSeat=-1;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socketRoom[socket.id]; delete socketRoom[socket.id];
    const room = rooms[code]; if (!room) return;
    const seat = seatOfSocket(room, socket.id); if (seat<0) return;
    const p = room.players[seat];
    if (room.started){
      // 游戏中：掉线者转为托管（当作机器人自动出牌）
      p.connected = false;
      // 若正等他决策，用默认值补上
      if (room.pending && room.pending.needed.has(seat)){
        room.pending.decisions[seat] = defaultDecision(room.pending.promptFor);
        room.pending.needed.delete(seat);
        if (room.pending.needed.size===0) room.pending.finish();
      }
      if (!humansPresent(room)){ destroyRoom(room); return; }
      // 掉线者若是房主，转移房主给下一个真人
      if (socket.id===room.hostId){ const nx=room.players.find(x=>!x.isBot&&x.connected); if(nx) room.hostId=nx.id; }
      broadcast(room);
    } else {
      // 大厅：直接移除
      room.players.splice(seat,1);
      if (!humansPresent(room)){ destroyRoom(room); return; }
      if (socket.id===room.hostId){ const nx=room.players.find(x=>!x.isBot&&x.connected); if(nx) room.hostId=nx.id; }
      broadcast(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIps();
  console.log('\n🎴  欢乐斗牛 · 联机版已启动！');
  console.log('────────────────────────────────');
  console.log('  本机访问：  http://localhost:' + PORT);
  ips.forEach(ip => console.log('  手机访问：  http://' + ip + ':' + PORT + '   （手机连同一 WiFi）'));
  console.log('────────────────────────────────');
  console.log('  房主用手机/电脑打开上面地址 → 创建房间 → 报房间号给朋友\n');
});
