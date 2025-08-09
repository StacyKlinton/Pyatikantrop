import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DEFAULT_FIREBASE_CONFIG } from "../firebaseConfig.js";

// ====== Firebase dynamic import ======
let firebaseApp = null, firebaseDb = null, firebaseAuth = null;
async function ensureFirebase(cfg) {
  const { initializeApp } = await import("firebase/app");
  const { getDatabase, ref, onValue, set, update, get } = await import("firebase/database");
  const { getAuth, signInAnonymously } = await import("firebase/auth");
  const DEFAULT_BOT_USERNAME = "pyatikantrop_online_bot"; // твой бот без @

  if (!firebaseApp) firebaseApp = initializeApp(cfg);
  if (!firebaseDb) firebaseDb = getDatabase(firebaseApp);
  if (!firebaseAuth) {
    firebaseAuth = getAuth(firebaseApp);
    try { await signInAnonymously(firebaseAuth); } catch {}
  }
  return { ref, onValue, set, update, get };
}

// ====== Telegram WebApp SDK dynamic load ======
async function ensureTelegram() {
  if (window?.Telegram?.WebApp) return window.Telegram.WebApp;
  await new Promise((res) => {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.onload = () => res();
    document.head.appendChild(s);
  });
  return window?.Telegram?.WebApp || null;
}

// ====== Game constants ======
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

function mkDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ id: `${r}${s}`, rank: r, suit: s });
  return cards;
}
function shuffle(arr, rng) { const a = arr.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function rng32(seed){ let x=seed||88675123; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return ((x>>>0)%1_000_000)/1_000_000; } }

function cardValue(c){ switch(c.rank){ case "A": return 11; case "10": return 10; case "K": return 4; case "J": return 25; case "Q": return 3; default: return 0; } }
function queensScore(hand){
  if (hand.length===0) return 0;
  const onlyQ = hand.every(c=>c.rank==="Q");
  if (onlyQ){
    if (hand.length===4) return 80;
    let base = 20*hand.length;
    if (hand.some(c=>c.suit==="♠")) base += 20;
    return base;
  }
  return hand.reduce((s,c)=>s+cardValue(c),0);
}
function canPlay(card, top, chosenSuit, chain, aceBonus){
  if (!top) return true;
  if (chain) return card.rank===chain.rank;
  if (aceBonus) return card.suit===top.suit;
  if (chosenSuit) return card.suit===chosenSuit || card.rank===top.rank;
  return card.suit===top.suit || card.rank===top.rank;
}

function startRound(prev=null, seed){
  const rng = rng32(seed ?? Math.floor(Math.random()*1e9));
  const deck = shuffle(mkDeck(), rng);
  const hands = [deck.slice(0,5), deck.slice(5,10)];
  const draw = deck.slice(10);
  const starter = ((prev?.starter ?? 1)===0) ? 1 : 0;
  const up = draw.pop(); const discard=[up]; let current=starter;
  let chosenSuit=null, chain=null, mustChooseSuit=false, aceBonus=false;
  let message = `Round start. Upcard: ${up.id}`;
  if (up.rank==="6"){ const opp=current===0?1:0; for(let i=0;i<2;i++) hands[opp].push(draw.pop()); message+=" — Initial 6: opponent +2"; }
  else if (up.rank==="7"){ const opp=current===0?1:0; hands[opp].push(draw.pop()); message+=" — Initial 7: opponent +1"; }
  else if (up.rank==="9"){ mustChooseSuit=true; message+=" — Initial 9: choose suit"; }
  return { seed: seed ?? Math.floor(Math.random()*1e9), draw, discard, hands, current, starter, chosenSuit, chain, aceBonus, mustChooseSuit, banks: prev?.banks ?? [0,0], roundOver:false, message, gameOver:{winner:null, loser:null, reason:null}, pNames: prev?.pNames ?? ["Player A","Player B"] };
}

export default function App(){
  // Конфиг берём из файла
  const [cfg, setCfg] = useState({ ...DEFAULT_FIREBASE_CONFIG });
  const [connected, setConnected] = useState(false);
  const [netMode, setNetMode] = useState("offline");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState(0);
  const [botUsername, setBotUsername] = useState("");
  const [tgName, setTgName] = useState("");

  const [state, setState] = useState(()=> startRound(null));
  const top = state.discard[state.discard.length-1];

  const dbAPI = useRef(null);
  const roomRef = useRef(null);

  // Автоподключение к Firebase при загрузке
  useEffect(() => {
    if (!connected) {
      (async () => {
        const api = await ensureFirebase(DEFAULT_FIREBASE_CONFIG);
        dbAPI.current = api;
        setConnected(true);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Telegram init
  useEffect(()=>{ (async()=>{
    const tg = await ensureTelegram();
    if (!tg) return;
    try { tg.ready(); tg.expand(); } catch {}
    const startParam = tg?.initDataUnsafe?.start_param;
    const user = tg?.initDataUnsafe?.user;
    if (user?.first_name) {
      const me = user.first_name + (user.username ? ` (@${user.username})` : "");
      setTgName(me);
      setState(prev => ({ ...prev, pNames: [me, prev.pNames ? prev.pNames[1] : "Player B"] }));
    }
    if (startParam && /^[0-9]{6}$/.test(startParam)) setRoomCode(startParam);
  })(); }, []);

  async function applyConfig(){ const api = await ensureFirebase(cfg); dbAPI.current = api; setConnected(true); }
  function labelPlayer(p){ return state.pNames ? state.pNames[p] : (p===0?"Player A":"Player B"); }

  async function createRoom(){
    if (!connected || !dbAPI.current) return alert("Apply Config first");
    const code = (Math.floor(100000+Math.random()*900000)).toString();
    setRoomCode(code);
    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${code}`);
    const round = startRound({ pNames: state.pNames }, undefined);
    const { getAuth } = await import("firebase/auth");
    const authUid = getAuth().currentUser?.uid || "host";
    await api.set(r, { game: round, players: { p0: authUid, p1: null }, createdAt: Date.now(), updatedAt: Date.now() });
    roomRef.current = r; setNetMode("online"); setPlayerId(0); subscribeRoom(r);
  }

  async function joinRoom(){
    if (!connected || !dbAPI.current) return alert("Apply Config first");
    if (!roomCode) return alert("Enter room code");
    const api = dbAPI.current;
    const r = api.ref(firebaseDb, `rooms/${roomCode}`);
    const { get } = await import("firebase/database");
    const snap = await get(r); if (!snap.exists()) return alert("Room not found");
    const { getAuth } = await import("firebase/auth");
    const authUid = getAuth().currentUser?.uid || "guest";
    const data = snap.val();
    if (!data.players.p1 && data.players.p0 !== authUid) {
      await api.update(r, { players: { ...data.players, p1: authUid }, updatedAt: Date.now() }); setPlayerId(1);
    } else if (data.players.p0 === authUid) setPlayerId(0);
    else if (data.players.p1 === authUid) setPlayerId(1);
    else return alert("Room is full");
    roomRef.current = r; setNetMode("online"); subscribeRoom(r);
  }

  function subscribeRoom(r){
    if (!dbAPI.current) return;
    dbAPI.current.onValue(r, (snap)=>{ if (!snap.exists()) return; const data = snap.val(); setState(data.game); });
  }

  async function pushGame(next){
    if (netMode!=="online" || !roomRef.current || !dbAPI.current) { setState(next); return; }
    await dbAPI.current.update(roomRef.current, { game: next, updatedAt: Date.now() });
  }

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
    let msg = `${labelPlayer(p)} played ${card.id}`;
    if (chain){ chain={rank:chain.rank, count:chain.count+1}; next = (p===0?1:0); msg += ` — chain ${chain.rank}×${chain.count}`; }
    else if (state.aceBonus){ next=(p===0?1:0); msg += " — Ace bonus used"; }
    else { if (card.rank==="6"){ chain={rank:"6",count:1}; next=(p===0?1:0); msg+=" — 6-chain (+2)"; }
           else if (card.rank==="7"){ chain={rank:"7",count:1}; next=(p===0?1:0); msg+=" — 7-chain (+1)"; }
           else if (card.rank==="9"){ mustChooseSuit=true; next=p; msg+=" — choose suit"; }
           else if (card.rank==="A"){ aceBonus=true; next=p; msg+=" — Ace: play same suit"; }
           else { next=(p===0?1:0); } }
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
    pushGame({ ...state, hands, draw, current: next, chain:null, chosenSuit:null, aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} drew ${take} and passed` });
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
    pushGame({ ...state, hands, draw, current: next, chosenSuit:null, aceBonus:false, mustChooseSuit:false, message: `${labelPlayer(p)} drew 1 and passed` });
  }

  function chooseSuit(s){ if (!state.mustChooseSuit) return; pushGame({ ...state, mustChooseSuit:false, chosenSuit:s, message:`Suit changed to ${s}` }); }
  function confirmSuit(){ if (!state.mustChooseSuit) return; const next=state.current===0?1:0; pushGame({ ...state, mustChooseSuit:false, current: next, message:`Suit set. Turn: ${labelPlayer(next)}` }); }

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
      if (banks[0]>=120 || banks[1]>=120){ const l=banks[0]>=120?0:1; const w=l===0?1:0; gameOver={winner:w,loser:l,reason:`Opponent hit 120`}; }
      else if (banks[0]<=-120 || banks[1]<=-120){ const w=banks[0]<=-120?0:1; const l=w===0?1:0; gameOver={winner:w,loser:l,reason:`Reached −120 with Queens`}; }
      const next = { ...state, banks, roundOver:true, gameOver, message:`Round over. ${labelPlayer(winner)} emptied hand. ${labelPlayer(loser)} ${onlyQ?"gets Queens deduction of":"gains"} ${pts}.` };
      pushGame(next);
    }
  }, [state.hands[0].length, state.hands[1].length, state.roundOver]);

  function nextRound(){ if (state.gameOver?.winner!==null) return; pushGame(startRound(state, state.seed+1)); }
  function resetLocal(){ setState(startRound(null)); setNetMode("offline"); setRoomCode(""); setBotUsername(""); }

  const playable = new Set(state.hands[state.current].filter(c=>canPlay(c, top, state.chosenSuit, state.chain, state.aceBonus)).map(c=>c.id));
function copyInvite() {
  // код комнаты должен быть
  if (!roomCode) return alert("Сначала создай комнату (Create Room)");
  // имя бота: либо из поля, либо дефолт
  const bot = (botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, "");
  const link = `https://t.me/${bot}?startapp=${roomCode}`;

  // если внутри Telegram — открываем системный «поделиться» в Telegram
  const tg = window?.Telegram?.WebApp;
  if (tg && tg.openTelegramLink) {
    // Вариант 1: открыть шэр-лист Telegram c заранее подставленной ссылкой и текстом
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Заходи в комнату Пятикантропа!")}`;
    tg.openTelegramLink(share);
    try { tg.HapticFeedback?.impactOccurred?.("light"); } catch {}
    return;
  }

  // В браузере — просто копируем в буфер
  navigator.clipboard.writeText(link)
    .then(() => alert("Ссылка приглашения скопирована:\n" + link))
    .catch(() => alert("Скопируй вручную:\n" + link));
}

  return (
    <div className="min-h-screen w-full bg-emerald-950/70" style={{backgroundImage:"radial-gradient(ellipse at center, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.7) 70%)"}}>
      <div className="max-w-7xl mx-auto p-4">
        <header className="flex flex-wrap items-center gap-2 justify-between mb-3">
          <h1 className="text-xl md:text-2xl font-bold text-emerald-100">🎴 Пятикарточный Пятикантроп — Online (Telegram ready)</h1>
          <div className="flex flex-wrap gap-2">
            <button className="px-3 py-2 rounded-2xl bg-slate-800/80 text-slate-100 border border-slate-700 hover:bg-slate-700" onClick={resetLocal}>New Local</button>
            {state.roundOver && state.gameOver?.winner===null && (
              <button className="px-3 py-2 rounded-2xl bg-emerald-700 hover:bg-emerald-600" onClick={nextRound}>Next Round</button>
            )}
          </div>
        </header>

        {/* Панель конфигурации показываем только если ещё не подключились */}
        {!connected && (
          <div className="grid md:grid-cols-3 gap-3 mb-4">
            <Panel title="Firebase Config">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.keys(cfg).map((k)=> (
                  <input key={k} className="px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-700" placeholder={k} value={cfg[k]} onChange={e=>setCfg((p)=>({...p,[k]:e.target.value}))}/>
                ))}
              </div>
              <button className="mt-2 px-3 py-2 rounded-xl bg-indigo-700 hover:bg-indigo-600" onClick={applyConfig}>{connected?"Reapply Config":"Apply Config"}</button>
            </Panel>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-3 mb-4">
          <Panel title="Online Room">
            <div className="flex gap-2 mb-2">
              <button className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600" onClick={createRoom} disabled={!connected}>Create Room</button>
<input
  className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700"
  placeholder="Bot username (без @), напр. pyatikantrop_online_bot"
  value={botUsername}
  onChange={e=>setBotUsername(e.target.value.replace(/^@/, ""))}
/>
              <button className="px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-600" onClick={joinRoom} disabled={!connected}>Join</button>
            </div>
            <div className="text-xs text-emerald-200">{netMode==="online"? `Room: ${roomCode} • You are ${playerId===0?"Player A":"Player B"}`: "Offline mode"}</div>
          </Panel>
          <Panel title="Telegram">
            <div className="text-xs mb-2">{tgName? `Hello, ${tgName}` : "(optional) Set Bot Username for invites"}</div>
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700" placeholder="Bot username (без @)" value={botUsername} onChange={e=>setBotUsername(e.target.value)} />
              <button className="px-3 py-2 rounded-xl bg-teal-700 hover:bg-teal-600" onClick={copyInvite}>Invite</button>
            </div>
            <div className="text-[11px] opacity-70 mt-1">Ссылка вида: t.me/&lt;bot&gt;?startapp=ROOMCODE</div>
          </Panel>
          <div />
        </div>

        <Table>
          <Seat label={`${state.pNames?.[playerId===0?1:0] || (playerId===0?"Player B":"Player A")}`} facing="down" highlight={state.current=== (playerId===0?1:0)}>
            <Hand cards={state.hands[playerId===0?1:0]} hidden />
          </Seat>

          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <AnimatePresence initial={false}>
                {state.discard.slice(-7).map((c, idx)=> (
                  <motion.div key={c.id+"/"+idx} initial={{opacity:0, y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
                    <PlayingCard card={c} raised={idx===state.discard.slice(-7).length-1}/>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            {state.chain && (<div className="px-3 py-2 rounded-xl bg-rose-900/50 border border-rose-800 text-rose-100 text-sm">Chain: <b>{state.chain.rank}</b> × <b>{state.chain.count}</b>. Only {state.chain.rank} allowed.</div>)}
            <div className="flex gap-2">
              {!state.chain && <ActionButton onClick={drawIfNoMove} disabled={netMode==="online" && state.current!==playerId}>No Move → Draw 1 & Pass</ActionButton>}
              {state.chain && <ActionButton onClick={drawPenalty} disabled={netMode==="online" && state.current!==playerId}>Draw Penalty & Pass</ActionButton>}
            </div>
            {state.mustChooseSuit && (
              <div className="flex gap-2">
                {SUITS.map(s=> <ActionButton key={s} onClick={()=>chooseSuit(s)}>{s}</ActionButton>)}
                <ActionButton onClick={confirmSuit}>Confirm</ActionButton>
              </div>
            )}
          </div>

          <Seat label={`${state.pNames?.[playerId] || (playerId===0?"Player A":"Player B")} (you)`} facing="up" highlight={state.current===playerId}>
            <Hand cards={state.hands[playerId]} selectable canPlay={(c)=>playable.has(c.id)} onSelect={playCard}/>
          </Seat>
        </Table>

        <div className="grid md:grid-cols-3 gap-3 mt-4">
          <Panel title="Player A bank"><div className="text-3xl font-semibold text-emerald-200">{state.banks[0]}</div></Panel>
          <Panel title="">
            {state.gameOver?.winner!==null && (
              <div className="p-3 rounded-xl bg-emerald-900/50 border border-emerald-800">
                <div className="text-lg font-semibold">Game Over</div>
                <div className="text-sm mt-1">Winner: <b>{state.gameOver?.winner===0? (state.pNames?.[0]||"Player A") : (state.pNames?.[1]||"Player B")}</b></div>
                <div className="text-sm mt-1">Reason: {state.gameOver?.reason}</div>
              </div>
            )}
          </Panel>
          <Panel title="Player B bank"><div className="text-3xl font-semibold text-emerald-200">{state.banks[1]}</div></Panel>
        </div>

        <details className="mt-6 bg-emerald-900/40 border border-emerald-800 rounded-2xl p-4">
          <summary className="cursor-pointer select-none font-semibold">Quick rules</summary>
          <ul className="list-disc pl-6 mt-3 text-sm space-y-1 opacity-90">
            <li>Match suit or rank. 6→+2 chain, 7→+1 chain, 9→change suit, A→extra same-suit play.</li>
            <li>During 6/7 chain only the same rank can be played; otherwise draw penalty.</li>
            <li>When a player empties hand, the other scores remaining cards; Queens-only invert score (deduct) with Q♠ = 40.</li>
            <li>First to 120+ loses. Reaching −120 via Queens instantly wins.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}

function Panel({ title, children }){ return <div className="rounded-2xl p-3 bg-emerald-950/40 border border-emerald-900 text-emerald-100"><div className="text-xs uppercase tracking-wider opacity-70 mb-1">{title}</div>{children}</div>; }
function ActionButton({children,onClick,disabled}){ return <button className={`px-3 py-2 rounded-xl border ${disabled?"opacity-50 cursor-not-allowed":"hover:scale-[1.02]"} bg-slate-900/60 border-slate-700`} onClick={onClick} disabled={disabled}>{children}</button>; }
function Table({children}){ return (<div className="rounded-[32px] p-6 md:p-8 border-4 border-emerald-900 shadow-2xl" style={{ background:"radial-gradient(circle at 50% 40%, rgba(16,74,50,.8), rgba(5,35,24,.95))", boxShadow:"inset 0 20px 80px rgba(0,0,0,.35), inset 0 -10px 30px rgba(0,0,0,.4)" }}><div className="grid grid-rows-[auto_auto_auto] gap-6 items-center justify-items-center">{children}</div></div>); }
function Seat({label, children, facing, highlight}){ return (<div className={`w-full ${facing==="down"?"rotate-180": ""}`}><div className={`mb-2 text-center text-sm ${highlight?"text-amber-300":"text-emerald-200/80"}`}>{label}</div><div className={`flex flex-wrap gap-2 items-center justify-center ${facing==="down"?"rotate-180":""}`}>{children}</div></div>); }
function Hand({ cards, hidden=false, selectable=false, canPlay, onSelect }){ return (<div className="flex flex-wrap gap-2 items-center justify-center">{cards.map((c, i)=>{ const playable = selectable && canPlay ? canPlay(c) : false; return (<button key={c.id+"-"+i} onClick={()=> onSelect && onSelect(c)} disabled={hidden || (selectable && !playable)} className={`transition ${playable&&!hidden?"hover:-translate-y-1": ""}`}><PlayingCard card={hidden? {id:"?",rank:"6",suit:"♣"} : c} faceDown={hidden} selectable={selectable} disabled={hidden || (selectable && !playable)} /></button>); })}</div>); }
function PlayingCard({ card, faceDown=false, raised=false, selectable=false, disabled=false }){ const red = card.suit==="♥" || card.suit==="♦"; return (<div className={`w-16 h-24 md:w-20 md:h-28 rounded-xl bg-white shadow-xl border ${raised?"border-amber-400":"border-slate-300"} grid place-items-center relative`} style={{ transform: raised? "translateY(-2px) rotateZ(-1deg)" : "rotateZ(-1deg)", boxShadow: "0 10px 20px rgba(0,0,0,.35)" }}>
  {faceDown ? (<div className="w-full h-full rounded-xl" style={{background:"repeating-linear-gradient(45deg, #113, #113 10px, #224 10px, #224 20px)"}}/>) : (
    <div className="w-full h-full px-1 py-1">
      <div className={`text-xs ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}</div>
      <div className={`text-base text-center ${red?"text-rose-600":"text-slate-800"}`}>{card.suit}</div>
      <div className={`absolute bottom-1 right-1 text-xs ${red?"text-rose-600":"text-slate-800"}`}>{card.rank}{card.suit}</div>
      {selectable && !disabled && <div className="absolute inset-0 rounded-xl ring-2 ring-emerald-400/70"/>}
    </div>
  )}
</div>); }


