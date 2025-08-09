// src/App.jsx
// ===============================
// Пятикарточный Пятикантроп — Online (Telegram)
// Полная версия с:
//  - ролями игроков через sessionId (больше никто "не станет Настей")
//  - self-join (играть за обе стороны в одной комнате)
//  - жеребьёвкой (больше/меньше) с синком через Firebase
//  - красивыми картами, светлыми кнопками, звуками (WebAudio)
//  - анимациями сдачи/подъёма карт (framer-motion)
//  - читабельным блоком правил
// ===============================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DEFAULT_FIREBASE_CONFIG } from "../firebaseConfig.js";

// ==== константы (глобально!) ====
const DEFAULT_BOT_USERNAME = "pyatikantrop_online_bot"; // без @
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

// Уникальный id сессии в этом браузере — используем для роли p0/p1
const SESSION_ID = (() => {
  const k = "pk_session_id";
  let v = localStorage.getItem(k);
  if (!v) { v = Math.random().toString(36).slice(2); localStorage.setItem(k, v); }
  return v;
})();

// ====== Firebase: динамический импорт SDK чтобы ускорить первый рендер ======
let firebaseApp = null, firebaseDb = null, firebaseAuth = null;
async function ensureFirebase(cfg) {
  const { initializeApp } = await import("firebase/app");
  const { getDatabase, ref, onValue, set, update, get } = await import("firebase/database");
  const { getAuth, signInAnonymously } = await import("firebase/auth");

  if (!firebaseApp) firebaseApp = initializeApp(cfg);
  if (!firebaseDb) firebaseDb = getDatabase(firebaseApp);
  if (!firebaseAuth) {
    firebaseAuth = getAuth(firebaseApp);
    try { await signInAnonymously(firebaseAuth); } catch {}
  }
  // возвращаем API для чтения/записи
  return { ref, onValue, set, update, get };
}

// ====== Telegram WebApp SDK грузим по требованию ======
async function ensureTelegram() {
  if (window?.Telegram?.WebApp) return window.Telegram.WebApp;
  await new Promise((res) => {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = () => res();
    document.head.appendChild(s);
  });
  return window?.Telegram?.WebApp || null;
}

// ====== утилиты игры ======
function mkDeck() { const cards=[]; for (const s of SUITS) for (const r of RANKS) cards.push({ id:`${r}${s}`, rank:r, suit:s }); return cards; }
function shuffle(arr, rng){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function rng32(seed){ let x=seed||88675123; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return ((x>>>0)%1_000_000)/1_000_000; }; }
function cardValue(c){ switch(c.rank){ case "A": return 11; case "10": return 10; case "K": return 4; case "J": return 25; case "Q": return 3; default: return 0; } }
function queensScore(hand){
  if(!hand.length) return 0;
  const onlyQ=hand.every(c=>c.rank==="Q");
  if(onlyQ){
    if(hand.length===4) return 80;
    let base=20*hand.length;
    if(hand.some(c=>c.suit==="♠")) base+=20;
    return base;
  }
  return hand.reduce((s,c)=>s+cardValue(c),0);
}
function canPlay(card, top, chosenSuit, chain, aceBonus){
  if (!top) return true;
  if (chain) return card.rank===chain.rank;         // в цепочке (6/7) разрешаем только ту же цифру
  if (aceBonus) return card.suit===top.suit;        // после туза можно положить ту же масть
  if (chosenSuit) return card.suit===chosenSuit || card.rank===top.rank;
  return card.suit===top.suit || card.rank===top.rank;
}

// старт нового раунда
function startRound(prev=null, seed){
  const rng = rng32(seed ?? Math.floor(Math.random()*1e9));
  const deck = shuffle(mkDeck(), rng);
  const hands = [deck.slice(0,5), deck.slice(5,10)];
  const draw = deck.slice(10);
  const starter = ((prev?.starter ?? 1)===0) ? 1 : 0; // меняем стартера по очереди
  const up = draw.pop(); const discard=[up]; let current=starter;
  let chosenSuit=null, chain=null, mustChooseSuit=false, aceBonus=false;
  let message = `Старт раунда. Верхняя карта: ${up.id}`;
  if (up.rank==="6"){ const opp=current===0?1:0; for(let i=0;i<2;i++) hands[opp].push(draw.pop()); message+=" — стартовая 6: соперник +2"; }
  else if (up.rank==="7"){ const opp=current===0?1:0; hands[opp].push(draw.pop()); message+=" — стартовая 7: соперник +1"; }
  else if (up.rank==="9"){ mustChooseSuit=true; message+=" — стартовая 9: выбери масть"; }
  return {
    seed: seed ?? Math.floor(Math.random()*1e9),
    draw, discard, hands, current, starter,
    chosenSuit, chain, aceBonus, mustChooseSuit,
    banks: prev?.banks ?? [0,0],
    roundOver:false, message,
    gameOver:{winner:null, loser:null, reason:null},
    pNames: prev?.pNames ?? ["Настя","Вика"]
  };
}

// ====== вариации анимаций для framer-motion ======
const dealVariants = {
  initial: { opacity: 0, y: 20, scale: 0.9, rotate: -4 },
  in:      { opacity: 1, y: 0,  scale: 1.0, rotate: -1, transition: { type: "spring", stiffness: 320, damping: 22 } },
  out:     { opacity: 0, y: -10, scale: 0.95, transition: { duration: 0.18 } }
};
const discardVariants = {
  initial: { opacity: 0, y: 10, scale: 0.95 },
  in: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 280, damping: 18 } }
};

// ====== простые звуки (без файлов) через WebAudio ======
function useBeep() {
  const audioCtxRef = useRef(null);
  function beep(freq=440, ms=70, gain=0.03) {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      const ctx = audioCtxRef.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + ms/1000);
    } catch {}
  }
  return beep;
}

// ===============================
//            КОМПОНЕНТ
// ===============================
export default function App(){
  const [cfg, setCfg] = useState({ ...DEFAULT_FIREBASE_CONFIG });
  const [connected, setConnected] = useState(false);
  const [netMode, setNetMode] = useState("offline");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState(0);
  const [botUsername, setBotUsername] = useState("");
  const [tgName, setTgName] = useState("");

  // состояние игры (отображается локально и/или синкается с БД)
  const [state, setState] = useState(()=> startRound(null));
  const top = state.discard[state.discard.length-1];

  // данные жеребьёвки (синхронизируем в БД «rooms/<room>/toss»)
  const [toss, setToss] = useState({ mode: "higher", myCard: null, oppCard: null, decided: false });

  // firebase api + ссылка на комнату
  const dbAPI = useRef(null);
  const roomRef = useRef(null);

  // звук
  const beep = useBeep();

  // авто-инициализация Firebase
  useEffect(() => { (async () => {
    if (!connected) {
      const api = await ensureFirebase(DEFAULT_FIREBASE_CONFIG);
      dbAPI.current = api; setConnected(true);
    }
  })(); }, [connected]);

  // Telegram init
  useEffect(()=>{ (async()=>{
    const tg = await ensureTelegram();
    if (!tg) return;
    try { tg.ready(); tg.expand(); } catch {}
    const startParam = tg?.initDataUnsafe?.start_param;
    if (startParam && /^[0-9]{6}$/.test(startParam)) setRoomCode(startParam);
    const user = tg?.initDataUnsafe?.user;
    if (user?.first_name) setTgName(user.first_name + (user.username ? ` (@${user.username})` : ""));
  })(); }, []);

  // применить ручной конфиг (если понадобится)
  async function applyConfig(){
    const api = await ensureFirebase(cfg);
    dbAPI.current = api; setConnected(true);
  }

  // label игрока
  function labelPlayer(p){ return state.pNames ? state.pNames[p] : (p===0?"Игрок A":"Игрок B"); }

  // создать комнату
  async function createRoom(){
    if (!connected || !dbAPI.current) return alert("Нажми Apply Config");
    const code = (Math.floor(100000+Math.random()*900000)).toString();
    setRoomCode(code);

    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${code}`);

    // начальное состояние игры и toss в БД
    const round = startRound({ pNames: state.pNames }, undefined);
    await api.set(r, {
      game: round,
      players: { p0: { sid: SESSION_ID }, p1: null },
      toss: { mode: "higher", p0: null, p1: null, decided: false },
      createdAt: Date.now(), updatedAt: Date.now()
    });

    roomRef.current = r; setNetMode("online"); setPlayerId(0); subscribeRoom(r);
    beep(520, 80, 0.03);
  }

  // войти в комнату
  async function joinRoom(){
    if (!connected || !dbAPI.current) return alert("Нажми Apply Config");
    if (!roomCode) return alert("Введи 6-значный Room code");

    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${roomCode}`);
    const snap = await api.get(r);
    if (!snap.exists()) return alert("Комната не найдена");

    const data = snap.val();
    // распределение ролей по sid (уникально для браузера)
    let me = "p0";
    if (!data.players?.p0) me = "p0";
    else if (!data.players?.p1) me = "p1";
    else if (data.players.p0?.sid === SESSION_ID) me = "p0";
    else if (data.players.p1?.sid === SESSION_ID) me = "p1";
    else return alert("В комнате уже два игрока");

    if (me === "p1" && !data.players?.p1) {
      await api.update(r, { players: { ...data.players, p1: { sid: SESSION_ID } }, updatedAt: Date.now() });
    } else if (me === "p0" && !data.players?.p0) {
      await api.update(r, { players: { p0: { sid: SESSION_ID }, p1: data.players?.p1??null }, updatedAt: Date.now() });
    }

    roomRef.current = r; setNetMode("online"); setPlayerId(me === "p0" ? 0 : 1); subscribeRoom(r);
  }

  // подписка на обновления комнаты
  function subscribeRoom(r){
    if (!dbAPI.current) return;
    const api = dbAPI.current;

    // слушаем саму игру
    api.onValue(r, (snap)=>{
      if (!snap.exists()) return;
      const data = snap.val();
      if (data.game) setState(data.game);

      // синхронизируем жеребьёвку
      const t = data.toss || { mode:"higher", p0:null, p1:null, decided:false };
      let myCard = toss.myCard, oppCard = toss.oppCard;
      if (playerId === 0) { myCard = t.p0; oppCard = t.p1; }
      else { myCard = t.p1; oppCard = t.p0; }
      setToss({ mode: t.mode, myCard, oppCard, decided: !!t.decided });
    });
  }

  // пушим новое состояние игры (локально или в БД)
  async function pushGame(next){
    if (netMode!=="online" || !roomRef.current || !dbAPI.current) { setState(next); return; }
    await dbAPI.current.update(roomRef.current, { game: next, updatedAt: Date.now() });
  }

  // ====== Ходы/действия ======
  function playCard(card){
    if (state.roundOver || state.gameOver?.winner!==null) return;
    if (netMode==="online" && state.current!==playerId) return;

    const p = state.current;
    const top = state.discard[state.discard.length-1];
    if (!canPlay(card, top, state.chosenSuit, state.chain, state.aceBonus)) return;

    const hands = [state.hands[0].slice(), state.hands[1].slice()];
    hands[p] = hands[p].filter(c=>c.id!==card.id);
    const discard = state.discard.concat([card]);

    let next=p, chain=state.chain, chosenSuit= state.mustChooseSuit?state.chosenSuit:null, aceBonus=false, mustChooseSuit=false;
    let msg = `${labelPlayer(p)} положил(а) ${card.id}`;
    if (chain){ chain={rank:chain.rank, count:chain.count+1}; next = (p===0?1:0); msg += ` — цепочка ${chain.rank}×${chain.count}`; }
    else if (state.aceBonus){ next=(p===0?1:0); msg += " — бонус туза"; }
    else {
      if (card.rank==="6"){ chain={rank:"6",count:1}; next=(p===0?1:0); msg+=" — 6-цепочка (+2)"; }
      else if (card.rank==="7"){ chain={rank:"7",count:1}; next=(p===0?1:0); msg+=" — 7-цепочка (+1)"; }
      else if (card.rank==="9"){ mustChooseSuit=true; next=p; msg+=" — выбери масть"; }
      else if (card.rank==="A"){ aceBonus=true; next=p; msg+=" — туз: ещё ход той же масти"; }
      else { next=(p===0?1:0); }
    }
    beep(620, 60, 0.03);
    pushGame({ ...state, hands, discard, current: next, chain, chosenSuit, aceBonus, mustChooseSuit, message: msg });
  }

  function drawPenalty(){
    if (!state.chain) return;
    if (netMode==="online" && state.current!==playerId) return;
    const p=state.current;
    const take= state.chain.rank==="6"? 2*state.chain.count: 1*state.chain.count;
    const hands=[state.hands[0].slice(), state.hands[1].slice()];
    const draw=state.draw.slice();
    for(let i=0;i<take;i++){ const c=draw.pop(); if(c) hands[p].push(c); }
    const next=p===0?1:0;
    beep(200, 120, 0.04);
    pushGame({ ...state, hands, draw, current: next, chain:null, chosenSuit:null, aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} взял(а) ${take} и пас` });
  }

  function drawIfNoMove(){
    if (state.chain) return;
    if (netMode==="online" && state.current!==playerId) return;
    const p=state.current;
    const draw=state.draw.slice();
    const c=draw.pop()||null;
    const hands=[state.hands[0].slice(), state.hands[1].slice()];
    if(c) hands[p].push(c);
    const next=p===0?1:0;
    beep(260, 90, 0.035);
    pushGame({ ...state, hands, draw, current: next, chosenSuit:null, aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} взял(а) 1 и пас` });
  }

  function chooseSuit(s){ if (!state.mustChooseSuit) return; pushGame({ ...state, mustChooseSuit:false, chosenSuit:s, message:`Масть изменена на ${s}` }); }
  function confirmSuit(){ if (!state.mustChooseSuit) return; const next=state.current===0?1:0; pushGame({ ...state, mustChooseSuit:false, current: next, message:`Масть установлена. Ход: ${labelPlayer(next)}` }); }

  // авто-подсчёт завершения раунда
  useMemo(()=>{
    const p0=state.hands[0].length, p1=state.hands[1].length;
    if (!state.roundOver && (p0===0 || p1===0)){
      const winner = p0===0?0:1; const loser= winner===0?1:0;
      const loserHand=state.hands[loser];
      const onlyQ= loserHand.length>0 && loserHand.every(c=>c.rank==="Q");
      let pts=queensScore(loserHand);
      const banks=[...state.banks];
      if (onlyQ) banks[loser]-=pts; else banks[loser]+=pts;
      let gameOver= state.gameOver||{winner:null,loser:null,reason:null};
      if (banks[0]>=120 || banks[1]>=120){ const l=banks[0]>=120?0:1; const w=l===0?1:0; gameOver={winner:w,loser:l,reason:`Соперник набрал 120`}; }
      else if (banks[0]<=-120 || banks[1]<=-120){ const w=banks[0]<=-120?0:1; const l=w===0?1:0; gameOver={winner:w,loser:l,reason:`Достиг −120 дамами`}; }
      const next = { ...state, banks, roundOver:true, gameOver, message:`Раунд окончен. ${labelPlayer(winner)} опустошил(а) руку. ${labelPlayer(loser)} ${onlyQ?"получает вычет за дам":"получает"} ${pts}.` };
      pushGame(next);
    }
  }, [state.hands[0].length, state.hands[1].length, state.roundOver]); // eslint-disable-line

  function nextRound(){ if (state.gameOver?.winner!==null) return; pushGame(startRound(state, state.seed+1)); }
  function resetLocal(){ setState(startRound(null)); setNetMode("offline"); setRoomCode(""); setBotUsername(""); setToss({mode:"higher", myCard:null, oppCard:null, decided:false}); }

  // список карт, которые можно класть в текущий ход
  const playable = new Set(state.hands[state.current].filter(c=>canPlay(c, top, state.chosenSuit, state.chain, state.aceBonus)).map(c=>c.id));

  // Телеграм-инвайт
  function copyInvite() {
    if (!roomCode) return alert("Сначала создай комнату (Create Room)");
    const bot = (botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, "");
    const link = `https://t.me/${bot}?startapp=${roomCode}`;

    const tg = window?.Telegram?.WebApp;
    if (tg && tg.openTelegramLink) {
      const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Заходи в комнату Пятикантропа!")}`;
      tg.openTelegramLink(share);
      try { tg.HapticFeedback?.impactOccurred?.("light"); } catch {}
      return;
    }
    navigator.clipboard.writeText(link)
      .then(() => alert("Ссылка приглашения скопирована:\n" + link))
      .catch(() => alert("Скопируй вручную:\n" + link));
  }

  // Self-join — занять второе место и играть «сам с собой»
  async function selfJoin() {
    if (!roomCode || !dbAPI.current) return alert("Сначала Create Room");
    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${roomCode}`);
    const snap = await api.get(r);
    if (!snap.exists()) return;
    const data = snap.val();
    if (!data.players?.p1) {
      await api.update(r, { players: { ...data.players, p1: { sid: SESSION_ID } }, updatedAt: Date.now() });
    }
    setNetMode("online");
    setPlayerId(1);
    subscribeRoom(r);
  }

  // ====== Жеребьёвка (синхронизирована через БД) ======
  async function tossSetMode(newMode) {
    if (netMode!=="online" || !roomRef.current || !dbAPI.current) return;
    await dbAPI.current.update(roomRef.current, { toss: { ...(tossToDb()), mode: newMode } });
  }
  async function tossDraw() {
    if (netMode!=="online" || !roomRef.current || !dbAPI.current || toss.decided) return;
    const deck = mkDeck(); const rng = rng32(Math.floor(Math.random()*1e9));
    const d = shuffle(deck, rng);
    const mine = d.pop();

    const api = dbAPI.current;
    const snap = await api.get(roomRef.current);
    if (!snap.exists()) return;
    const data = snap.val();
    const t = data.toss || { mode: "higher", p0:null, p1:null, decided:false };

    // сохраняем свою карту в БД
    if (playerId===0 && !t.p0) t.p0 = mine;
    if (playerId===1 && !t.p1) t.p1 = mine;

    // если обе карты вытянуты — решаем стартера и фиксируем в game.current
    if (t.p0 && t.p1 && !t.decided) {
      const order = RANKS;
      const vi = order.indexOf(t.p0.rank);
      const oi = order.indexOf(t.p1.rank);
      const p0win = t.mode==="higher" ? (vi>oi) : (vi<oi);
      const starter = p0win ? 0 : 1;

      const nextGame = { ...data.game, starter, current: starter, message: `Жеребьёвка: ${t.p0.id} vs ${t.p1.id}. Начинает ${starter===0?data.game.pNames[0]:data.game.pNames[1]}` };
      await api.update(roomRef.current, { toss: { ...t, decided:true }, game: nextGame, updatedAt: Date.now() });
      beep(700,90,0.035);
    } else {
      await api.update(roomRef.current, { toss: t, updatedAt: Date.now() });
    }
  }
  function tossToDb(){
    // конвертация локального toss → вид в БД: чьи карты где
    return {
      mode: toss.mode,
      p0: playerId===0 ? toss.myCard : toss.oppCard,
      p1: playerId===1 ? toss.myCard : toss.oppCard,
      decided: toss.decided
    };
  }

  const turnText = state.gameOver?.winner!==null
    ? `Игра окончена: победа ${labelPlayer(state.gameOver.winner)}`
    : `Ход: ${labelPlayer(state.current)}${netMode==="online" ? (state.current===playerId?" • твой ход":" • ждём соперника") : ""}`;

  // =================== РЕНДЕР ===================
  return (
    <div className="min-h-screen w-full bg-emerald-950/70" style={{backgroundImage:"radial-gradient(ellipse at center, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.7) 70%)"}}>
      <div className="max-w-7xl mx-auto p-4">
        <header className="flex flex-wrap items-center gap-2 justify-between mb-3">
          <h1 className="text-xl md:text-2xl font-bold text-emerald-100">🎴 Пятикарточный Пятикантроп — Online (Telegram)</h1>
          <div className="flex flex-wrap gap-2">
            <button className="px-3 py-2 rounded-2xl bg-slate-800/80 text-slate-100 border border-slate-700 hover:bg-slate-700" onClick={resetLocal}>New Local</button>
            {state.roundOver && state.gameOver?.winner===null && (
              <button className="px-3 py-2 rounded-2xl bg-emerald-700 hover:bg-emerald-600" onClick={nextRound}>Next Round</button>
            )}
          </div>
        </header>

        {/* статус хода */}
        <div className="mb-3 px-3 py-2 rounded-xl bg-emerald-900/40 border border-emerald-800 text-emerald-100 text-sm">
          {turnText}{state.message ? ` • ${state.message}` : ""}
        </div>

        {/* конфиг показываем, если ещё нет подключения */}
        {!connected && (
          <div className="grid md:grid-cols-3 gap-3 mb-4">
            <Panel title="Firebase Config">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.keys(cfg).map((k)=> (
                  <input key={k} className="px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-700" placeholder={k} value={cfg[k]} onChange={e=>setCfg((p)=>({...p,[k]:e.target.value}))}/>
                ))}
              </div>
              <button className="mt-2 px-3 py-2 rounded-xl bg-indigo-700 hover:bg-indigo-600" onClick={applyConfig}>Apply Config</button>
            </Panel>
          </div>
        )}

        {/* онлайн/инвайт/селф-джоин */}
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          <Panel title="Online Room">
            <div className="flex gap-2 mb-2">
              <button className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600" onClick={createRoom} disabled={!connected}>Create Room</button>
              <input className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700" placeholder="Enter 6-digit code" value={roomCode} onChange={e=>setRoomCode(e.target.value.replace(/\D/g,"").slice(0,6))} />
              <button className="px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-600" onClick={joinRoom} disabled={!connected}>Join</button>
            </div>
            <div className="flex gap-2">
              <ActionButton tone="light" onClick={selfJoin} disabled={netMode!=="online"}>Играть за обе стороны (Self-Join)</ActionButton>
            </div>
            <div className="text-xs text-emerald-200 mt-1">{netMode==="online"? `Room: ${roomCode} • Ты — ${playerId===0?"Player A":"Player B"}`: "Offline mode"}</div>
          </Panel>

          <Panel title="Telegram Invite">
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700" placeholder="Bot username (без @)" value={botUsername} onChange={e=>setBotUsername(e.target.value.replace(/^@/, ""))} />
              <button className="px-3 py-2 rounded-xl bg-teal-700 hover:bg-teal-600" onClick={copyInvite}>Invite</button>
            </div>
            <div className="text-[11px] opacity-70 mt-1">Ссылка: t.me/&lt;bot&gt;?startapp=ROOMCODE</div>
          </Panel>

          {/* Жеребьёвка (больше/меньше) */}
          {netMode==="online" && !toss.decided && (
            <Panel title="Жеребьёвка: кто ходит первым">
              <div className="text-sm mb-2">Режим: {toss.mode==="higher"?"бОльшая карта":"мЕньшая карта"} начинает.</div>
              <div className="flex gap-2 mb-2">
                <ActionButton tone="light" onClick={()=>{ setToss(t=>({...t, mode:"higher"})); tossSetMode("higher"); }}>Больше</ActionButton>
                <ActionButton tone="light" onClick={()=>{ setToss(t=>({...t, mode:"lower"})); tossSetMode("lower"); }}>Меньше</ActionButton>
                <ActionButton onClick={tossDraw}>Тянуть карту</ActionButton>
              </div>
              {(toss.myCard || toss.oppCard) && (
                <div className="flex items-center gap-4">
                  <div className="text-sm">Ты:</div><PlayingCard card={toss.myCard || {rank:"?", suit:"♣", id:"?"}}/>
                  <div className="text-sm">Соперник:</div><PlayingCard card={toss.oppCard || {rank:"?", suit:"♣", id:"?"}}/>
                </div>
              )}
            </Panel>
          )}
        </div>

        {/* СТОЛ */}
        <Table>
          {/* Верхняя рука. Имя НЕ переворачиваем, только карты. */}
          <Seat label={`${state.pNames?.[playerId===0?1:0] || (playerId===0?"Вика":"Настя")}`} facing="down" highlight={state.current=== (playerId===0?1:0)}>
            <Hand cards={state.hands[playerId===0?1:0]} hidden />
          </Seat>

          {/* Центр: сброс + действия */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <AnimatePresence initial={false}>
                {state.discard.slice(-7).map((c, idx)=> (
                  <motion.div
                    key={c.id+"/"+idx}
                    variants={discardVariants}
                    initial="initial" animate="in"
                  >
                    <PlayingCard card={c} raised={idx===state.discard.slice(-7).length-1}/>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {/* Сообщения про цепочку / кнопки действий */}
            {state.chain && (
              <div className="px-3 py-2 rounded-xl bg-rose-900/50 border border-rose-800 text-rose-100 text-sm">
                Цепочка: <b>{state.chain.rank}</b> × <b>{state.chain.count}</b>. Разрешены только {state.chain.rank}.
              </div>
            )}

            <div className="flex gap-2">
              {!state.chain && (
                <ActionButton tone="light" onClick={drawIfNoMove} disabled={netMode==="online" && state.current!==playerId}>
                  Нет хода → Взять 1 и пас
                </ActionButton>
              )}
              {state.chain && (
                <ActionButton tone="warn" onClick={drawPenalty} disabled={netMode==="online" && state.current!==playerId}>
                  Взять штраф и пас
                </ActionButton>
              )}
            </div>

            {/* выбор масти после 9 */}
            {state.mustChooseSuit && (
              <div className="flex gap-2">
                {SUITS.map(s=> <ActionButton key={s} onClick={()=>chooseSuit(s)}>{s}</ActionButton>)}
                <ActionButton onClick={confirmSuit}>Подтвердить</ActionButton>
              </div>
            )}
          </div>

          {/* Нижняя рука (твои карты) */}
          <Seat label={`${state.pNames?.[playerId] || (playerId===0?"Настя":"Вика")} (ты)`} facing="up" highlight={state.current===playerId}>
            <Hand
              cards={state.hands[playerId]}
              selectable
              canPlay={(c)=>playable.has(c.id)}
              onSelect={playCard}
            />
          </Seat>
        </Table>

        {/* Банки и итоги */}
        <div className="grid md:grid-cols-3 gap-3 mt-4">
          <Panel title="Банк Насти"><div className="text-3xl font-semibold text-emerald-200">{state.banks[0]}</div></Panel>
          <Panel title="">
            {state.gameOver?.winner!==null && (
              <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900">
                <div className="text-lg font-semibold">Игра окончена</div>
                <div className="text-sm mt-1">Победитель: <b>{state.gameOver?.winner===0? (state.pNames?.[0]||"Настя") : (state.pNames?.[1]||"Вика")}</b></div>
                <div className="text-sm mt-1">Причина: {state.gameOver?.reason}</div>
              </div>
            )}
          </Panel>
          <Panel title="Банк Вики"><div className="text-3xl font-semibold text-emerald-200">{state.banks[1]}</div></Panel>
        </div>

        {/* Правила — светлый, читабельный блок */}
        <div className="mt-6 rounded-2xl p-4 bg-emerald-50 border border-emerald-200 text-emerald-900">
          <div className="cursor-default select-none font-semibold mb-2">Краткие правила</div>
          <ul className="list-disc pl-6 space-y-1 text-[15px] leading-6">
            <li>Совпадение по масти или по рангу. 6→+2 цепочка, 7→+1, 9→смена масти, A→ещё ход той же масти.</li>
            <li>Во время цепочки 6/7 можно класть только 6/7 соответственно, иначе берёшь штраф.</li>
            <li>Если у проигравшего только дамы — они дают по 20 (Q♠ +20), четыре дамы = 80. Эти очки вычитаются из его банка.</li>
            <li>Кто набрал 120+, тот проиграл. Достиг −120 за счёт дам — мгновенная победа.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ===============================
//       МАЛЕНЬКИЕ КОМПОНЕНТЫ
// ===============================

// Карточные панели
function Panel({ title, children }) {
  return (
    <div className="rounded-2xl p-3 bg-emerald-950/40 border border-emerald-900 text-emerald-100">
      <div className="text-xs uppercase tracking-wider opacity-70 mb-1">{title}</div>
      {children}
    </div>
  );
}

// Кнопка с тонами: тёмная / светлая / предупреждение
function ActionButton({children,onClick,disabled,tone="dark"}) {
  const base = "px-3 py-2 rounded-xl border transition";
  const tones = {
    dark: "bg-slate-900/60 border-slate-700 hover:scale-[1.02] text-emerald-100",
    light: "bg-white border-slate-300 hover:scale-[1.02] text-slate-900 shadow",
    warn: "bg-amber-100 border-amber-300 hover:scale-[1.02] text-amber-900"
  };
  return (
    <button
      className={`${base} ${tones[tone]} ${disabled?"opacity-50 cursor-not-allowed":""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// Контейнер стола
function Table({children}) {
  return (
    <div
      className="rounded-[32px] p-6 md:p-8 border-4 border-emerald-900 shadow-2xl"
      style={{
        background:"radial-gradient(circle at 50% 40%, rgba(16,74,50,.8), rgba(5,35,24,.95))",
        boxShadow:"inset 0 20px 80px rgba(0,0,0,.35), inset 0 -10px 30px rgba(0,0,0,.4)"
      }}
    >
      <div className="grid grid-rows-[auto_auto_auto] gap-6 items-center justify-items-center">{children}</div>
    </div>
  );
}

// Место игрока: подпись НЕ переворачиваем, переворачиваются только карты
function Seat({label, children, facing, highlight}) {
  return (
    <div className="w-full">
      <div className={`mb-2 text-center text-sm ${highlight?"text-amber-300":"text-emerald-200/80"}`}>{label}</div>
      <div className={`${facing==="down"?"rotate-180":""} flex flex-wrap gap-2 items-center justify-center`}>
        {children}
      </div>
    </div>
  );
}

// Рука игрока — с анимацией сдачи карт
function Hand({ cards, hidden=false, selectable=false, canPlay, onSelect }) {
  return (
    <div className="flex flex-wrap gap-2 items-center justify-center">
      <AnimatePresence initial={false}>
        {cards.map((c, i)=>{
          const playable = selectable && canPlay ? canPlay(c) : false;
          return (
            <motion.button
              key={c.id+"-"+i}
              variants={dealVariants}
              initial="initial" animate="in" exit="out"
              onClick={()=> onSelect && onSelect(c)}
              disabled={hidden || (selectable && !playable)}
              className={`transition ${playable&&!hidden?"hover:-translate-y-1": ""}`}
            >
              <PlayingCard
                card={hidden? {id:"?",rank:"6",suit:"♣"} : c}
                faceDown={hidden}
                selectable={selectable}
                disabled={hidden || (selectable && !playable)}
              />
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// Отрисовка одной карты — дорогой, «глянцевый» вид
function PlayingCard({ card, faceDown=false, raised=false, selectable=false, disabled=false }) {
  const red = card.suit==="♥" || card.suit==="♦";
  const suitEmoji = card.suit; // уже символы мастей
  return (
    <div
      className={`w-16 h-24 md:w-20 md:h-28 rounded-2xl border grid place-items-center relative select-none`}
      style={{
        background: faceDown
          ? "repeating-linear-gradient(45deg, #13233a 0 10px, #1e3252 10px 20px)"
          : "linear-gradient(180deg,#fff 0%, #fafafa 100%)",
        borderColor: raised ? "#fbbf24" : "#d0d7de",
        boxShadow: "0 12px 24px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.6)",
        transform: raised? "translateY(-2px) rotateZ(-1deg)" : "rotateZ(-1deg)"
      }}
    >
      {!faceDown ? (
        <div className="w-full h-full px-2 py-1">
          <div className={`text-xs font-semibold ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}</div>
          <div className={`text-lg text-center ${red?"text-rose-600":"text-slate-800"}`}>{suitEmoji}</div>
          <div className={`absolute bottom-1 right-2 text-xs ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}{suitEmoji}</div>
          {selectable && !disabled && <div className="absolute inset-0 rounded-2xl ring-2 ring-emerald-400/70"/>}
        </div>
      ) : null}
    </div>
  );
}



