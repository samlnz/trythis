
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Points to your Python Flask server (e.g., http://localhost:5000 or a Railway internal URL)
const FINANCE_API_URL = process.env.FINANCE_API_URL || 'http://localhost:5000'; 
const APP_URL = process.env.APP_URL || `https://${process.env.RAILWAY_STATIC_URL || 'localhost:5173'}`;

// --- TELEGRAM BOT SETUP ---
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;
if (bot) {
  bot.start((ctx) => {
    ctx.replyWithMarkdownV2(
      `*Welcome to Star Bingo Pro\\!* 🌠\n\nYour celestial wallet is linked\\. Top up via the bot and play in real-time\\.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🚀 Launch Arena', APP_URL)]])
    );
  });
  bot.launch().catch(err => console.error('❌ Bot Launch Error:', err));
}

// --- GAME CONSTANTS ---
const PHASES = { SELECTION: 'SELECTION', PLAYING: 'PLAYING', WINNER: 'WINNER' };
const SELECTION_TIME = 45 * 1000; 
const WINNER_TIME = 12 * 1000;    
const BALL_INTERVAL = 4000;       
const ENTRY_FEE = 10;

let gameState = {
  roundId: Math.floor(Date.now() / 1000),
  phase: PHASES.SELECTION,
  nextPhaseTime: Date.now() + SELECTION_TIME,
  phaseStartTime: Date.now(),
  participants: [], // Real human players only
  calledNumbers: [],
  sequence: [],
  winner: null
};

// --- BINGO LOGIC ---
function generateCardNumbers(cardNumber) {
  const columnRanges = { 'B': [1, 15], 'I': [16, 30], 'N': [31, 45], 'G': [46, 60], 'O': [61, 75] };
  const cardNumbers = [];
  const columns = ['B', 'I', 'N', 'G', 'O'];
  columns.forEach((col, colIdx) => {
    let seed = cardNumber * 100 + colIdx;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const range = columnRanges[col];
    const avail = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
    for (let i = avail.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [avail[i], avail[j]] = [avail[j], avail[i]];
    }
    cardNumbers.push(...avail.slice(0, 5).sort((a, b) => a - b));
  });
  cardNumbers[12] = 0; 
  return cardNumbers;
}

function checkBingo(cardId, calledSet) {
  const nums = generateCardNumbers(cardId);
  const patterns = [
    [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
    [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
    [0,6,12,18,24], [4,8,12,16,20], [0,4,20,24]
  ];
  return patterns.some(p => p.every(idx => idx === 12 || calledSet.has(nums[idx])));
}

// --- PYTHON INTEGRATION ---
async function chargeEntries() {
  if (gameState.participants.length === 0) return;
  console.log(`📡 Processing entry fees for ${gameState.participants.length} players...`);
  for (const p of gameState.participants) {
    try {
      const totalAmount = p.cardIds.length * ENTRY_FEE;
      const res = await fetch(`${FINANCE_API_URL}/api/game/entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: p.playerId, amount: totalAmount, roundId: gameState.roundId })
      });
      if (!res.ok) console.warn(`⚠️ Failed to charge ${p.playerId}: ${res.statusText}`);
    } catch (e) {
      console.error(`❌ Finance Sync Error (Charge):`, e.message);
    }
  }
}

async function payoutWinner(winner) {
  if (!winner) return;
  // Prize = Total Pool - 20% House Cut
  const prize = Math.floor(gameState.participants.reduce((acc, p) => acc + (p.cardIds.length * ENTRY_FEE), 0) * 0.8);
  if (prize <= 0) return;

  try {
    console.log(`🏆 Crediting ${winner.playerId} with ${prize} ETB...`);
    await fetch(`${FINANCE_API_URL}/api/game/win`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: winner.playerId, amount: prize, roundId: gameState.roundId })
    });
  } catch (e) {
    console.error(`❌ Finance Sync Error (Win):`, e.message);
  }
}

// --- ENGINE CYCLE ---
function initNewRound() {
  gameState.roundId = Math.floor(Date.now() / 1000);
  gameState.phase = PHASES.SELECTION;
  gameState.phaseStartTime = Date.now();
  gameState.nextPhaseTime = Date.now() + SELECTION_TIME;
  gameState.calledNumbers = [];
  gameState.winner = null;
  gameState.participants = []; 
  
  const nums = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  gameState.sequence = nums;
  console.log(`✨ Round #${gameState.roundId} Ready.`);
}

function engineTick() {
  const now = Date.now();
  if (gameState.phase === PHASES.SELECTION) {
    if (now >= gameState.nextPhaseTime) {
      gameState.phase = PHASES.PLAYING;
      gameState.phaseStartTime = now;
      gameState.nextPhaseTime = now; 
      chargeEntries(); 
    }
  } else if (gameState.phase === PHASES.PLAYING) {
    if (now >= gameState.nextPhaseTime) {
      const nextNum = gameState.sequence[gameState.calledNumbers.length];
      if (nextNum) {
        gameState.calledNumbers.push(nextNum);
        const calledSet = new Set(gameState.calledNumbers);
        let roundWinner = null;

        for (const p of gameState.participants) {
          for (const cid of p.cardIds) {
            if (checkBingo(cid, calledSet)) {
              roundWinner = { playerId: p.playerId, name: p.name, cardId: cid };
              break;
            }
          }
          if (roundWinner) break;
        }

        if (roundWinner) {
          gameState.winner = roundWinner;
          gameState.phase = PHASES.WINNER;
          gameState.nextPhaseTime = now + WINNER_TIME;
          payoutWinner(roundWinner);
        } else {
          gameState.nextPhaseTime = now + BALL_INTERVAL;
        }
      } else {
        initNewRound();
      }
    }
  } else if (gameState.phase === PHASES.WINNER) {
    if (now >= gameState.nextPhaseTime) initNewRound();
  }
}

initNewRound();
setInterval(engineTick, 1000);

const app = express();
app.use(cors());
app.use(express.json());
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));

app.get('/api/game/state', (req, res) => res.json({ ...gameState, serverTime: Date.now() }));

app.post('/api/game/join', (req, res) => {
  const { playerId, name, cardIds } = req.body;
  if (gameState.phase !== PHASES.SELECTION) return res.status(400).json({ error: 'Selection phase closed' });
  
  gameState.participants = gameState.participants.filter(p => p.playerId !== playerId);
  if (cardIds.length > 0) {
    gameState.participants.push({ playerId, name, cardIds });
    
    // Notify Python DB of participation
    fetch(`${FINANCE_API_URL}/api/game/participate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, username: name, cardIds, roundId: gameState.roundId })
    }).catch(e => console.error("Sync participate fail:", e.message));
  }

  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Star Bingo Engine online on port ${PORT}`));
