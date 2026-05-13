import express from "express";
import cors from "cors";
import { ServeGrip } from "@fanoutio/serve-grip";

const app = express();
app.use(cors());
app.use(express.json());

// ── Configuración ────────────────────────────────────────────────────────────
const FASTLY_SERVICE_ID = process.env.FASTLY_SERVICE_ID || "";
const FASTLY_API_TOKEN  = process.env.FASTLY_API_TOKEN  || "";
const IS_LOCAL          = process.env.NODE_ENV !== "production";

// serve-grip solo para detectar req.grip.isProxied y manejar el handshake
// Para publicar usamos fetch directo al API de Fastly (más confiable)
const serveGrip = new ServeGrip({
  grip: IS_LOCAL ? "http://localhost:5561/" : { control_uri: "http://localhost/" }, // placeholder
});
app.use(serveGrip);

// Endpoint de publicación
const FANOUT_PUBLISH_URL = IS_LOCAL
  ? "http://localhost:5561/publish/"
  : `https://api.fastly.com/service/${FASTLY_SERVICE_ID}/publish/`;

// ── Publicar via fetch directo ───────────────────────────────────────────────
async function publishToChannel(channel, eventType, data) {
  const sseContent = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = JSON.stringify({
    items: [{ channel, formats: { "http-stream": { content: sseContent } } }],
  });

  const headers = { "Content-Type": "application/json" };
  if (!IS_LOCAL) headers["Authorization"] = `Bearer ${FASTLY_API_TOKEN}`;

  try {
    const res = await fetch(FANOUT_PUBLISH_URL, { method: "POST", headers, body });
    if (!res.ok) {
      console.error(`[Fanout] Publish failed ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[Fanout] ✅ "${eventType}" → "${channel}"`);
    }
  } catch (err) {
    console.error(`[Fanout] fetch failed:`, err.message);
  }
}

async function publishMatchUpdate(matchId, eventType, data) {
  await Promise.all([
    publishToChannel(`match-${matchId}`, eventType, data),
    publishToChannel("live-scores",      eventType, { matchId, ...data }),
  ]);
}

// ── Estado de partidos ───────────────────────────────────────────────────────
const matches = {
  "match-001": {
    id: "match-001",
    homeTeam: { name: "Real Madrid",     flag: "🇪🇸", score: 0 },
    awayTeam: { name: "Bayern Múnich",   flag: "🇩🇪", score: 0 },
    status: "live", minute: 0,
    competition: "UEFA Champions League", venue: "Santiago Bernabéu", events: [],
  },
  "match-002": {
    id: "match-002",
    homeTeam: { name: "Barcelona",       flag: "🇪🇸", score: 0 },
    awayTeam: { name: "PSG",             flag: "🇫🇷", score: 0 },
    status: "live", minute: 0,
    competition: "UEFA Champions League", venue: "Spotify Camp Nou", events: [],
  },
  "match-003": {
    id: "match-003",
    homeTeam: { name: "Manchester City", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", score: 0 },
    awayTeam: { name: "Inter Miami",     flag: "🇺🇸", score: 0 },
    status: "live", minute: 0,
    competition: "Club World Cup", venue: "MetLife Stadium", events: [],
  },
  "match-004": {
    id: "match-004",
    homeTeam: { name: "América",         flag: "🇲🇽", score: 0 },
    awayTeam: { name: "Chivas",          flag: "🇲🇽", score: 0 },
    status: "live", minute: 0,
    competition: "Liga MX", venue: "Estadio Azteca", events: [],
  },
};

const players = {
  "match-001": { home: ["Vinícius Jr.", "Mbappé",    "Bellingham", "Rodrygo"],  away: ["Kane",       "Müller", "Sané",   "Goretzka"] },
  "match-002": { home: ["Lewandowski",  "Yamal",     "Pedri",      "Gavi"],     away: ["Dembélé",    "Neymar", "Mbappé", "Verratti"] },
  "match-003": { home: ["Haaland",      "De Bruyne", "Foden",      "Silva"],    away: ["Messi",      "Suárez", "Alba",   "Busquets"] },
  "match-004": { home: ["Álvarez",      "Valdés",    "Fidalgo",    "Zendejas"], away: ["Chicharito", "Vega",   "Antuna", "Pizarro"]  },
};

// ── API REST ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ service: "Futbol Fanout Origin", status: "running",
    mode: IS_LOCAL ? "LOCAL" : "PRODUCTION", publishUrl: FANOUT_PUBLISH_URL });
});

app.get("/api/matches", (req, res) => {
  res.json({ matches: Object.values(matches) });
});

app.get("/api/matches/:matchId", (req, res) => {
  const match = matches[req.params.matchId];
  if (!match) return res.status(404).json({ error: "Not found" });
  res.json(match);
});

// ── SSE con GRIP ─────────────────────────────────────────────────────────────
app.get("/stream/live", (req, res) => {
  if (req.grip?.isProxied) {
    // Request viene de Fanout — emitir instrucciones GRIP
    const gripInstruct = res.grip.startInstruct();
    gripInstruct.addChannel("live-scores");
    gripInstruct.setHoldStream();
    res.setHeader("Content-Type", "text/event-stream");
    const allMatches = Object.values(matches);
    res.end(`event: init\ndata: ${JSON.stringify(allMatches)}\n\n`);
  } else {
    // Request directa (health check, etc.)
    res.json({ message: "SSE stream — accede via Fastly Fanout edge" });
  }
});

app.get("/stream/match/:matchId", (req, res) => {
  const match = matches[req.params.matchId];
  if (!match) return res.status(404).json({ error: "Match not found" });

  if (req.grip?.isProxied) {
    const gripInstruct = res.grip.startInstruct();
    gripInstruct.addChannel(`match-${req.params.matchId}`);
    gripInstruct.setHoldStream();
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`event: init\ndata: ${JSON.stringify(match)}\n\n`);
  } else {
    res.json(match);
  }
});

// ── Simulador ────────────────────────────────────────────────────────────────
function getRandomPlayer(matchId, team) {
  const list = players[matchId]?.[team] ?? ["Jugador"];
  return list[Math.floor(Math.random() * list.length)];
}

function simulateMatch(matchId) {
  const match = matches[matchId];
  if (!match || match.status === "finished") return;

  match.minute += 1;

  if (match.minute % 5 === 0) {
    publishMatchUpdate(matchId, "clock", {
      matchId, minute: match.minute,
      homeScore: match.homeTeam.score, awayScore: match.awayTeam.score,
    });
  }

  const roll = Math.random();

  if (roll < 0.06) {
    const side   = Math.random() < 0.5 ? "homeTeam" : "awayTeam";
    const scorer = getRandomPlayer(matchId, side === "homeTeam" ? "home" : "away");
    match[side].score += 1;
    const event = {
      type: "goal", matchId, minute: match.minute,
      team: match[side].name, player: scorer,
      homeScore: match.homeTeam.score, awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name,  awayTeam:  match.awayTeam.name,
    };
    match.events.push(event);
    console.log(`⚽ GOL! ${scorer} (${match[side].name}) min ${match.minute}`);
    publishMatchUpdate(matchId, "goal", event);

  } else if (roll < 0.10) {
    const side     = Math.random() < 0.5 ? "home" : "away";
    const player   = getRandomPlayer(matchId, side);
    const cardType = Math.random() < 0.85 ? "yellow" : "red";
    const event = {
      type: "card", matchId, minute: match.minute, cardType, player,
      team: side === "home" ? match.homeTeam.name : match.awayTeam.name,
    };
    match.events.push(event);
    publishMatchUpdate(matchId, "card", event);

  } else if (roll < 0.14) {
    const side  = Math.random() < 0.5 ? "home" : "away";
    const event = {
      type: "substitution", matchId, minute: match.minute,
      playerOut: getRandomPlayer(matchId, side),
      playerIn:  `Reserva #${Math.floor(Math.random() * 9) + 12}`,
      team: side === "home" ? match.homeTeam.name : match.awayTeam.name,
    };
    match.events.push(event);
    publishMatchUpdate(matchId, "substitution", event);
  }

  if (match.minute === 45) {
    publishMatchUpdate(matchId, "halftime", {
      matchId, homeScore: match.homeTeam.score, awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name, awayTeam: match.awayTeam.name,
    });
  }

  if (match.minute >= 90) {
    match.status = "finished";
    publishMatchUpdate(matchId, "fulltime", {
      matchId, homeScore: match.homeTeam.score, awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name, awayTeam: match.awayTeam.name,
    });
    console.log(`🏁 Fin ${matchId}`);
  }
}

function startSimulation() {
  Object.keys(matches).forEach((matchId, idx) => {
    const ms = 3500 + idx * 800;
    setInterval(() => simulateMatch(matchId), ms);
    console.log(`⏱  ${matchId} cada ${ms}ms`);
  });
}

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Origin en http://localhost:${PORT}`);
  console.log(`📡 Publish URL: ${FANOUT_PUBLISH_URL}`);
  console.log(`🌐 Modo: ${IS_LOCAL ? "LOCAL" : "PRODUCCIÓN"}\n`);
  startSimulation();
});
