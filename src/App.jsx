// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DEFAULT_FIREBASE_CONFIG } from "../firebaseConfig.js";

/* ===================== КОНСТАНТЫ ===================== */
const DEFAULT_BOT_USERNAME = "pyatikantrop_online_bot"; // имя бота без @
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

/* ===================== FIREBASE (ленивая загрузка SDK) ===================== */
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
  return { ref, onValue, set, update, get };
}

/* ===================== Telegram WebApp SDK ===================== */
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

/* ===================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===================== */
function mkDeck(){ const cards=[]; for (const s of SUITS) for (const r of RANKS) cards.push({ id:`${r}${s}`, rank:r, suit:s }); return cards; }
function shuffle(arr, rng){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function rng32(seed){ let x=seed||88675123; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return ((x>>>0)%1_000_000)/1_000_000; }; }

function cardValue(c){
  switch(c.rank){
    case "A": return 11;
    case "10": return 10;
    case "K": return 4;
    case "J": return 25;
    case "Q": return 3;
    default: return 0;
  }
}

// очки, если на руках только дамы
function queensScoreOnly(hand){
  let score = 20 * hand.length;
  if (hand.some(c => c.rank==="Q" && c.suit==="♠")) score += 20;
  return score; // 4 дамы = 80 (+20 если среди них ♠ — у тебя это отдельное правило)
}

function handScore(hand){
  if (!hand.length) return 0;
  const allQueens = hand.every(c=>c.rank==="Q");
  return allQueens ? queensScoreOnly(hand)
                   : hand.reduce((s,c)=>s+cardValue(c),0);
}

function canPlay(card, top, chosenSuit, chain, aceBonus){
  if (!top) return true;
  if (chain)      return card.rank===chain.rank;                  // во время цепочки 6/7 — только 6 или 7
  if (aceBonus)   return card.suit===top.suit;                    // после туза — только та же масть
  if (chosenSuit) return card.suit===chosenSuit || card.rank===top.rank; // после 9 — выбранная масть или совп. ранг
  return card.suit===top.suit || card.rank===top.rank;
}

/* ===================== СОСТОЯНИЕ РАУНДА ===================== */
function rankWeight(r){ const order={ "6":1,"7":2,"8":3,"9":4,"10":5,"J":6,"Q":7,"K":8,"A":9 }; return order[r]||0; }
function cardTxt(c){ return `${c.rank}${c.suit}`; }

function startRound(prev=null, seed){
  const rng = rng32(seed ?? Math.floor(Math.random()*1e9));
  const deck = shuffle(mkDeck(), rng);

  // Жеребьёвка (авто, на «больше»)
  const tossA = deck.pop();
  const tossB = deck.pop();
  const goesFirst = rankWeight(tossA.rank) >= rankWeight(tossB.rank) ? 0 : 1;

  // Раздача по 5
  const hands = [deck.slice(-5), deck.slice(-10, -5)];
  deck.length -= 10;

  // Верхняя карта
  const up = deck.pop();
  const discard = [up];

  // Эффекты верхней карты
  let chosenSuit=null, chain=null, mustChooseSuit=false, aceBonus=false;
  let message = `Жеребьёвка: ${cardTxt(tossA)} vs ${cardTxt(tossB)} → первый ходит ${goesFirst===0?"Настя":"Вика"}. Верхняя: ${cardTxt(up)}.`;
  const current = goesFirst;

  if (up.rank==="6"){
    const opp=current===0?1:0;
    for(let i=0;i<2;i++) hands[opp].push(deck.pop());
    message += " Стартовая 6: соперник +2.";
  } else if (up.rank==="7"){
    const opp=current===0?1:0;
    hands[opp].push(deck.pop());
    message += " Стартовая 7: соперник +1.";
  } else if (up.rank==="9"){
    mustChooseSuit = true;
    message += " Стартовая 9: выбери масть.";
  }

  return {
    phase: "play",
    seed: seed ?? Math.floor(Math.random()*1e9),
    draw: deck,
    discard,
    hands,
    current,
    starter: goesFirst,
    chosenSuit, chain, aceBonus, mustChooseSuit,
    banks: prev?.banks ?? [0,0],
    roundOver:false,
    message,
    gameOver:{winner:null, loser:null, reason:null},
    pNames: prev?.pNames ?? ["Настя","Вика"]
  };
}

/* ===================== ОСНОВНОЙ КОМПОНЕНТ ===================== */
export default function App(){
  // сетевое состояние
  const [cfg, setCfg] = useState({ ...DEFAULT_FIREBASE_CONFIG });
  const [connected, setConnected] = useState(false);
  const [netMode, setNetMode] = useState("offline"); // offline | online
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState(0);        // 0 — нижний, 1 — верхний
  const [solo, setSolo] = useState(false);            // режим «играю за двоих»
  const [botUsername, setBotUsername] = useState("");
  const [tgName, setTgName] = useState("");

  // игровое состояние
  const [state, setState] = useState(()=> startRound(null));
  const top = state.discard[state.discard.length-1];

  // firebase refs
  const dbAPI = useRef(null);
  const roomRef = useRef(null);
  const pushingRef = useRef(false);

  /* ---------- Авто-инициализация Firebase ---------- */
  useEffect(() => {
    (async () => {
      if (!connected) {
        const api = await ensureFirebase(DEFAULT_FIREBASE_CONFIG);
        dbAPI.current = api;
        setConnected(true);
      }
    })();
  }, [connected]);

  /* ---------- авто-join по ссылке из TG после подключения ---------- */
  useEffect(() => {
    if (netMode === "offline" && connected && roomCode && roomCode.length === 6) {
      joinRoom().catch(()=>{});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, roomCode]);

  /* ---------- Telegram init ---------- */
  useEffect(()=>{ (async()=>{
    const tg = await ensureTelegram();
    if (!tg) return;
    try { tg.ready(); tg.expand(); } catch {}
    const startParam = tg?.initDataUnsafe?.start_param;
    const user = tg?.initDataUnsafe?.user;
    if (user?.first_name) {
      const me = user.first_name + (user.username ? ` (@${user.username})` : "");
      setTgName(me);
      setState(prev => ({ ...prev, pNames: ["Настя","Вика"] }));
    }
    if (startParam && /^[0-9]{6}$/.test(startParam)) setRoomCode(startParam);
  })(); }, []);

  /* ---------- Применить конфиг вручную (если нужно) ---------- */
  async function applyConfig(){
    const api = await ensureFirebase(cfg);
    dbAPI.current = api; setConnected(true);
  }

  function labelPlayer(p){ return state.pNames ? state.pNames[p] : (p===0?"Игрок A":"Игрок B"); }

  /* ---------- Создать комнату ---------- */
  async function createRoom(){
    if (!connected || !dbAPI.current) return alert("Нажми Apply Config");
    const code = (Math.floor(100000+Math.random()*900000)).toString();
    setRoomCode(code);

    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${code}`);
    const round = startRound({ pNames: ["Настя","Вика"] }, undefined);

    const { getAuth } = await import("firebase/auth");
    const authUid = getAuth().currentUser?.uid || "host";

    await api.set(r, { game: round, players: { p0: authUid, p1: null }, createdAt: Date.now(), updatedAt: Date.now() });
    roomRef.current = r; setNetMode("online"); setPlayerId(0); subscribeRoom(r);
  }

  /* ---------- Присоединиться ---------- */
  async function joinRoom(){
    if (!connected || !dbAPI.current) return alert("Нажми Apply Config");
    if (!roomCode) return alert("Введи 6-значный Room code");

    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${roomCode}`);
    const { get } = await import("firebase/database");
    const snap = await get(r);
    if (!snap.exists()) return alert("Комната не найдена");

    const { getAuth } = await import("firebase/auth");
    const authUid = getAuth().currentUser?.uid || "guest";
    const data = snap.val();

    if (!data.players.p1 && data.players.p0 !== authUid) {
      await api.update(r, { players: { ...data.players, p1: authUid }, updatedAt: Date.now() });
      setPlayerId(1);
    } else if (data.players.p0 === authUid) {
      setPlayerId(0);
    } else if (data.players.p1 === authUid) {
      setPlayerId(1);
    } else {
      return alert("В комнате уже 2 игрока");
    }
    roomRef.current = r; setNetMode("online"); subscribeRoom(r);
  }

  /* ---------- Подписка ---------- */
  function subscribeRoom(r){
    if (!dbAPI.current) return;
    dbAPI.current.onValue(r, (snap)=>{
      if (!snap.exists()) return;
      const data = snap.val();
      setState(data.game);
    });
  }

  /* ---------- Пушим новое состояние ---------- */
  async function pushGame(next){
    if (pushingRef.current) return;
    pushingRef.current = true;
    try {
      if (netMode!=="online" || !roomRef.current || !dbAPI.current) {
        setState(next);
      } else {
        await dbAPI.current.update(roomRef.current, { game: next, updatedAt: Date.now() });
      }
    } finally {
      pushingRef.current = false;
    }
  }

  /* ---------- Положить карту ---------- */
  function playCard(card){
    if (state.roundOver || state.gameOver?.winner!==null) return;
    if (!solo && netMode==="online" && state.current!==playerId) return;

    const p = state.current;
    const top = state.discard[state.discard.length-1];
    if (!canPlay(card, top, state.chosenSuit, state.chain, state.aceBonus)) return;

    const hands = [state.hands[0].slice(), state.hands[1].slice()];
    hands[p] = hands[p].filter(c=>c.id!==card.id);

    const discard = state.discard.concat([card]);

    let next=p, chain=state.chain, chosenSuit=state.mustChooseSuit ? state.chosenSuit : null,
        aceBonus=false, mustChooseSuit=false;

    let msg = `${labelPlayer(p)} положил(а) ${cardTxt(card)}.`;

    if (chain){
      chain = { rank: chain.rank, count: chain.count + 1 };
      next = (p===0?1:0);
      msg += ` Цепочка ${chain.rank}×${chain.count}.`;
    } else if (state.aceBonus){
      next = (p===0?1:0);
      msg += " Бонус туза использован.";
    } else {
      if (card.rank==="6"){ chain={rank:"6",count:1}; next=(p===0?1:0); msg+=" 6-цепочка (+2)."; }
      else if (card.rank==="7"){ chain={rank:"7",count:1}; next=(p===0?1:0); msg+=" 7-цепочка (+1)."; }
      else if (card.rank==="9"){ mustChooseSuit=true; next=p; msg+=" Выбери масть."; }
      else if (card.rank==="A"){ aceBonus=true; next=p; msg+=" Туз: ещё одна карта той же масти."; }
      else { next=(p===0?1:0); }
    }

    pushGame({ ...state, hands, discard, current: next, chain, chosenSuit, aceBonus, mustChooseSuit, message: msg });
  }

  /* ---------- Взять штраф (во время цепочки) ---------- */
  function drawPenalty(){
    if (!state.chain) return;
    if (!solo && netMode==="online" && state.current!==playerId) return;

    const p = state.current;
    const take = state.chain.rank==="6" ? 2*state.chain.count : 1*state.chain.count;

    const hands=[state.hands[0].slice(), state.hands[1].slice()];
    const draw=state.draw.slice();
    for(let i=0;i<take;i++){ const c=draw.pop(); if(c) hands[p].push(c); }

    const next=p===0?1:0;
    pushGame({ ...state, hands, draw, current: next, chain:null, chosenSuit:null,
      aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} взял(а) ${take} и пас.` });
  }

  /* ---------- Нет хода → взять 1 и пас ---------- */
  function drawIfNoMove(){
    if (state.chain) return;       // при цепочке — жми «штраф»
    if (state.aceBonus) return;    // после туза нужно докладывать той же масти
    if (!solo && netMode==="online" && state.current!==playerId) return;

    const p = state.current;
    const draw = state.draw.slice();
    const c = draw.pop() || null;

    const hands=[state.hands[0].slice(), state.hands[1].slice()];
    if (c) hands[p].push(c);

    const tookText = c ? "взял(а) 1" : "колода пуста — пас без взятия";
    const next=p===0?1:0;

    pushGame({ ...state, hands, draw, current: next, chosenSuit:null,
      aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} ${tookText}.` });
  }

  /* ---------- Выбор масти после 9 ---------- */
  function chooseSuit(s){
    if (!state.mustChooseSuit) return;
    pushGame({ ...state, mustChooseSuit:false, chosenSuit:s, message:`Масть изменена на ${s}.` });
  }
  function confirmSuit(){
    if (!state.mustChooseSuit) return;
    const next=state.current===0?1:0;
    pushGame({ ...state, mustChooseSuit:false, current: next, message:`Масть подтверждена. Ход: ${labelPlayer(next)}.` });
  }

  /* ---------- Конец раунда ---------- */
  useMemo(()=>{
    const p0=state.hands[0].length, p1=state.hands[1].length;
    if (!state.roundOver && (p0===0 || p1===0)){
      const winner = p0===0?0:1;
      const loser  = winner===0?1:0;
      const loserHand = state.hands[loser];

      const onlyQueens = loserHand.length>0 && loserHand.every(c=>c.rank==="Q");
      let pts = onlyQueens ? queensScoreOnly(loserHand) : handScore(loserHand);

      const banks=[...state.banks];
      if (onlyQueens) banks[loser] -= pts; else banks[loser] += pts;

      let gameOver = state.gameOver || {winner:null,loser:null,reason:null};
      if (banks[0]>=120 || banks[1]>=120){
        const l = banks[0]>=120 ? 0 : 1;
        const w = l===0?1:0;
        gameOver = {winner:w, loser:l, reason:"Соперник набрал 120 очков"};
      } else if (banks[0]<=-120 || banks[1]<=-120){
        const w = banks[0]<=-120 ? 0 : 1;
        const l = w===0?1:0;
        gameOver = {winner:w, loser:l, reason:"Достиг −120 за счёт дам"};
      }

      const next = {
        ...state, banks, roundOver:true, gameOver,
        message:`Раунд окончен. ${labelPlayer(winner)} опустошил(а) руку. ${labelPlayer(loser)} ${onlyQueens?"получает «минус» за дам ":"получает "} ${pts}.`
      };
      pushGame(next);
    }
  }, [state.hands[0].length, state.hands[1].length, state.roundOver]);

  /* ---------- Новый раунд / локальный сброс ---------- */
  function nextRound(){ if (state.gameOver?.winner!==null) return; pushGame(startRound(state, state.seed+1)); }
  function resetLocal(){ setState(startRound(null)); setNetMode("offline"); setRoomCode(""); setBotUsername(""); }

  /* ---------- Приглашение в Telegram ---------- */
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

  /* ---------- Подсказка статуса хода ---------- */
  const turnText = state.gameOver?.winner!==null
    ? `Игра окончена: победа — ${labelPlayer(state.gameOver.winner)}. ${state.gameOver.reason}.`
    : `Ход: ${labelPlayer(state.current)}${netMode==="online"&&!solo ? (state.current===playerId?" • твой ход":" • ждём соперника") : (solo?" • SOLO (играешь за обоих)":"")}`;

  /* ---------- Сеты «сыграемых» карт для каждой руки ---------- */
  const playableBottom = new Set(
    state.hands[0]
      .filter(c=>canPlay(c, top, state.chosenSuit, state.chain, state.aceBonus))
      .map(c=>c.id)
  );
  const playableTop = new Set(
    state.hands[1]
      .filter(c=>canPlay(c, top, state.chosenSuit, state.chain, state.aceBonus))
      .map(c=>c.id)
  );

  /* ===================== UI ===================== */
  return (
    <div className="min-h-screen w-full"
         style={{background:"radial-gradient(circle at 50% 20%, #0f3c2c, #071c15 60%, #05130e 100%)"}}>
      <div className="max-w-7xl mx-auto p-4">
        {/* заголовок */}
        <header className="flex flex-wrap items-center gap-2 justify-between mb-3">
          <h1 className="text-xl md:text-2xl font-bold text-emerald-100">🎴 Пятикарточный Пятикантроп — Online (Telegram)</h1>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-emerald-200 text-sm">
              <input type="checkbox" checked={solo} onChange={e=>setSolo(e.target.checked)} />
              Solo (играю за двоих)
            </label>
            <button className="px-3 py-2 rounded-2xl bg-slate-800/80 text-slate-100 border border-slate-700 hover:bg-slate-700" onClick={resetLocal}>New Local</button>
            {state.roundOver && state.gameOver?.winner===null && (
              <button className="px-3 py-2 rounded-2xl bg-emerald-700 hover:bg-emerald-600" onClick={nextRound}>Next Round</button>
            )}
          </div>
        </header>

        {/* статус/сообщение — на белом фоне */}
        <div className="mb-3 px-3 py-2 rounded-xl border shadow-sm text-slate-800 bg-white/95">
          {turnText}{state.message ? ` • ${state.message}` : ""}
        </div>

        {/* конфиг показываем, если ещё не подключены */}
        {!connected && (
          <div className="grid md:grid-cols-3 gap-3 mb-4">
            <Panel title="Firebase Config">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.keys(cfg).map((k)=> (
                  <input key={k} className="px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-700 text-emerald-100"
                         placeholder={k} value={cfg[k]} onChange={e=>setCfg((p)=>({...p,[k]:e.target.value}))}/>
                ))}
              </div>
              <button className="mt-2 px-3 py-2 rounded-xl bg-indigo-700 hover:bg-indigo-600" onClick={applyConfig}>Apply Config</button>
            </Panel>
          </div>
        )}

        {/* панель комнаты и инвайта */}
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          <Panel title="Online Room">
            <div className="flex gap-2 mb-2">
              <button className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600" onClick={createRoom} disabled={!connected}>Create Room</button>
              <input className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 text-emerald-100"
                     placeholder="Enter 6-digit code"
                     value={roomCode}
                     onChange={e=>setRoomCode(e.target.value.replace(/\D/g,"").slice(0,6))} />
              <button className="px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-600" onClick={joinRoom} disabled={!connected}>Join</button>
            </div>
            <div className="text-xs text-emerald-200">
              {netMode==="online"? `Room: ${roomCode} • Ты — ${playerId===0?"нижний":"верхний"} игрок` : "Offline mode"}
            </div>
          </Panel>

          <Panel title="Telegram Invite">
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 text-emerald-100"
                     placeholder="Bot username (без @)"
                     value={botUsername}
                     onChange={e=>setBotUsername(e.target.value.replace(/^@/, ""))} />
              <button className="px-3 py-2 rounded-xl bg-teal-700 hover:bg-teal-600" onClick={copyInvite}>Invite</button>
            </div>
            <div className="text-[11px] opacity-70 mt-1 text-emerald-200">
              Ссылка вида: t.me/&lt;bot&gt;?startapp=ROOMCODE
            </div>
          </Panel>

          <div />
        </div>

        {/* игровое поле */}
        <Table>
          {/* верхний игрок — Вика (имя НЕ переворачиваем; переворачиваются только карты) */}
          <Seat label={`${state.pNames?.[1] || "Вика"}`} facing="down" highlight={state.current===1}>
            <Hand
              cards={state.hands[1]}
              hidden={!solo}                               // в SOLO показываем карты Вики
              selectable={solo && state.current===1}       // кликать можно, если SOLO и её ход
              canPlay={(c)=> playableTop.has(c.id)}
              onSelect={playCard}
            />
          </Seat>

          {/* центр стола */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <AnimatePresence initial={false}>
                {state.discard.slice(-7).map((c, idx)=> (
                  <motion.div key={c.id+"/"+idx}
                    initial={{opacity:0, y:12, scale:0.98}}
                    animate={{opacity:1, y:0,   scale:1}}
                    exit={{opacity:0, y:-8,  scale:0.98}}
                    transition={{type:"spring", stiffness:300, damping:20}}>
                    <PlayingCard card={c} raised={idx===state.discard.slice(-7).length-1}/>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {state.chain && (
              <div className="px-3 py-2 rounded-xl bg-rose-900/60 border border-rose-800 text-rose-100 text-sm">
                Цепочка: <b>{state.chain.rank}</b> × <b>{state.chain.count}</b>. Разрешены только {state.chain.rank}.
              </div>
            )}
            {state.mustChooseSuit && (
              <div className="flex gap-2">
                {SUITS.map(s=> <ActionButton key={s} onClick={()=>chooseSuit(s)}>{s}</ActionButton>)}
                <ActionButton onClick={confirmSuit}>Подтвердить</ActionButton>
              </div>
            )}

            {/* действия хода (белые кнопки для читабельности) */}
            <div className="flex gap-2">
              {!state.chain && (
                <button className="px-3 py-2 rounded-xl border bg-white text-slate-800 hover:shadow"
                        onClick={drawIfNoMove}
                        disabled={!solo && netMode==="online" && state.current!==playerId}>
                  Нет хода → Взять 1 и пас
                </button>
              )}
              {state.chain && (
                <button className="px-3 py-2 rounded-xl border bg-white text-slate-800 hover:shadow"
                        onClick={drawPenalty}
                        disabled={!solo && netMode==="online" && state.current!==playerId}>
                  Взять штраф и пас
                </button>
              )}
            </div>
          </div>

          {/* нижний игрок — Настя */}
          <Seat label={`${state.pNames?.[0] || "Настя"} (ты)`} facing="up" highlight={state.current===0}>
            <Hand
              cards={state.hands[0]}
              selectable={solo || state.current===0}
              canPlay={(c)=> playableBottom.has(c.id)}
              onSelect={playCard}
            />
          </Seat>
        </Table>

        {/* банки и итоги */}
        <div className="grid md:grid-cols-3 gap-3 mt-4">
          <Panel title="Банк Насти"><div className="text-3xl font-semibold text-emerald-200">{state.banks[0]}</div></Panel>
          <Panel title="">
            {state.gameOver?.winner!==null && (
              <div className="p-3 rounded-xl bg-emerald-900/50 border border-emerald-800 text-emerald-100">
                <div className="text-lg font-semibold">Итог игры</div>
                <div className="text-sm mt-1">
                  Победитель: <b>{state.gameOver?.winner===0? (state.pNames?.[0]||"Настя") : (state.pNames?.[1]||"Вика")}</b>
                </div>
                <div className="text-sm mt-1">Причина: {state.gameOver?.reason}</div>
              </div>
            )}
          </Panel>
          <Panel title="Банк Вики"><div className="text-3xl font-semibold text-emerald-200">{state.banks[1]}</div></Panel>
        </div>

        {/* правила (светлее) */}
        <details className="mt-6 rounded-2xl p-4 border bg-emerald-50/90 text-emerald-900">
          <summary className="cursor-pointer select-none font-semibold">Краткие правила</summary>
          <ul className="list-disc pl-6 mt-3 text-sm space-y-1">
            <li>Совпадение по масти или рангу. 6→+2 (цепочка), 7→+1 (цепочка), 9→смена масти, A→ещё ход той же масти.</li>
            <li>Во время цепочки 6/7 разрешены только 6/7 соответственно; иначе берёшь весь штраф и пас.</li>
            <li>Конец раунда: соперник считает очки за свои карты. Если только дамы — их сумма вычитается (Q♠ +20).</li>
            <li>Кто набрал 120+, тот проиграл. Достиг −120 за счёт дам — мгновенная победа.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}

/* ===================== МЕЛКИЕ КОМПОНЕНТЫ UI ===================== */
function Panel({ title, children }){
  return (
    <div className="rounded-2xl p-3 bg-emerald-950/40 border border-emerald-900 text-emerald-100">
      <div className="text-xs uppercase tracking-wider opacity-70 mb-1">{title}</div>
      {children}
    </div>
  );
}

function ActionButton({children,onClick}){
  return (
    <button className="px-3 py-2 rounded-xl border bg-white text-slate-800 hover:shadow" onClick={onClick}>
      {children}
    </button>
  );
}

function Table({children}){
  return (
    <div className="rounded-[32px] p-6 md:p-8 border-4 border-emerald-900 shadow-2xl"
         style={{ background:"radial-gradient(circle at 50% 40%, rgba(16,74,50,.85), rgba(5,35,24,.96))",
                  boxShadow:"inset 0 20px 80px rgba(0,0,0,.35), inset 0 -10px 30px rgba(0,0,0,.4)" }}>
      <div className="grid grid-rows-[auto_auto_auto] gap-6 items-center justify-items-center">
        {children}
      </div>
    </div>
  );
}

// Имя НЕ поворачиваем; поворачиваем только карты у верхнего.
function Seat({label, children, facing, highlight}){
  return (
    <div className="w-full">
      {/* имя оставляем как есть */}
      <div className={`mb-2 text-center text-sm ${highlight ? "text-amber-300" : "text-emerald-200/80"}`}>
        {label}
      </div>

      {/* ВАЖНО: без rotate-180, чтобы карты были «норм» */}
      <div className="flex flex-wrap gap-2 items-center justify-center">
        {children}
      </div>
    </div>
  );
}


function Hand({ cards, hidden=false, selectable=false, canPlay, onSelect }){
  return (
    <div className="flex flex-wrap gap-2 items-center justify-center">
      {cards.map((c, i)=>{
        const can = selectable && canPlay ? canPlay(c) : false;
        return (
          <motion.button
            layout
            key={c.id+"-"+i}
            onClick={()=> onSelect && onSelect(c)}
            disabled={hidden || (selectable && !can)}
            whileHover={(!hidden && can) ? { y: -6 } : {}}
            initial={{ opacity: 0, y: hidden ? 0 : 12, scale: hidden ? 1 : 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type:"spring", stiffness:420, damping:28 }}
          >
            <PlayingCard
              card={hidden ? {id:"?", rank:"6", suit:"♣"} : c}
              faceDown={hidden}
              selectable={selectable}
              disabled={hidden || (selectable && !can)}
            />
          </motion.button>
        );
      })}
    </div>
  );
}

function PlayingCard({ card, faceDown=false, raised=false, selectable=false, disabled=false }){
  const red = card.suit==="♥" || card.suit==="♦";
  return (
    <motion.div
      className={`w-16 h-24 md:w-20 md:h-28 rounded-xl bg-white shadow-xl border ${raised?"border-amber-400":"border-slate-300"} grid place-items-center relative`}
      style={{ boxShadow: "0 10px 20px rgba(0,0,0,.35)" }}
      layout
    >
      {faceDown ? (
        <div className="w-full h-full rounded-xl"
             style={{background:"repeating-linear-gradient(45deg, #132, #132 10px, #253 10px, #253 20px)"}}/>
      ) : (
        <div className="w-full h-full px-1 py-1">
          <div className={`text-xs ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}</div>
          <div className={`text-base text-center ${red?"text-rose-600":"text-slate-800"}`}>{card.suit}</div>
          <div className={`absolute bottom-1 right-1 text-xs ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}{card.suit}</div>
          {selectable && !disabled && <div className="absolute inset-0 rounded-xl ring-2 ring-emerald-400/70"/>}
        </div>
      )}
    </motion.div>
  );
}



