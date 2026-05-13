/**
 * Origin Server - Marcadores de Fútbol en Tiempo Real
 * 
 * Este servidor:
 * 1. Sirve el frontend estático
 * 2. Expone API REST de partidos
 * 3. Simula actualizaciones de marcadores
 * 4. Publica al canal Fanout de Fastly → llega a TODOS los clientes suscritos
 * 
 * En producción: POST a https://api.fastly.com/service/{SERVICE_ID}/publish/
 * En local:      POST a http://localhost:5561/publish/ (Pushpin local)
 */

import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "../frontend")));

// ── Configuración Fanout ─────────────────────────────────────────────────────
const FASTLY_SERVICE_ID = process.env.FASTLY_SERVICE_ID || "YOUR_SERVICE_ID";
const FASTLY_API_TOKEN  = process.env.FASTLY_API_TOKEN  || "YOUR_API_TOKEN";
const IS_LOCAL          = process.env.NODE_ENV !== "production";

// En local usamos el endpoint Pushpin; en prod, el de Fastly
const FANOUT_PUBLISH_URL = IS_LOCAL
  ? "http://localhost:5561/publish/"
  : `https://api.fastly.com/service/${FASTLY_SERVICE_ID}/publish/`;

// ── Estado de los partidos ───────────────────────────────────────────────────
const matches = {
  "match-001": {
    id: "match-001",
    homeTeam: { name: "Real Madrid",    flag: "🇪🇸", logo: "⚽", score: 0 },
    awayTeam: { name: "Bayern Múnich",  flag: "🇩🇪", logo: "⚽", score: 0 },
    status: "live",
    minute: 0,
    competition: "UEFA Champions League",
    venue: "Santiago Bernabéu",
    events: [],
  },
  "match-002": {
    id: "match-002",
    homeTeam: { name: "Barcelona",      flag: "🇪🇸", logo: "⚽", score: 0 },
    awayTeam: { name: "PSG",            flag: "🇫🇷", logo: "⚽", score: 0 },
    status: "live",
    minute: 0,
    competition: "UEFA Champions League",
    venue: "Spotify Camp Nou",
    events: [],
  },
  "match-003": {
    id: "match-003",
    homeTeam: { name: "Manchester City", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", logo: "⚽", score: 0 },
    awayTeam: { name: "Inter Miami",     flag: "🇺🇸", logo: "⚽", score: 0 },
    status: "live",
    minute: 0,
    competition: "Club World Cup",
    venue: "MetLife Stadium",
    events: [],
  },
  "match-004": {
    id: "match-004",
    homeTeam: { name: "América",         flag: "🇲🇽", logo: "⚽", score: 0 },
    awayTeam: { name: "Chivas",          flag: "🇲🇽", logo: "⚽", score: 0 },
    status: "live",
    minute: 0,
    competition: "Liga MX",
    venue: "Estadio Azteca",
    events: [],
  },
};

const players = {
  "match-001": {
    home: ["Vinícius Jr.", "Mbappé", "Bellingham", "Rodrygo"],
    away: ["Kane",  "Müller", "Sané", "Goretzka"],
  },
  "match-002": {
    home: ["Lewandowski", "Yamal", "Pedri", "Gavi"],
    away: ["Dembélé", "Neymar", "Mbappé", "Verratti"],
  },
  "match-003": {
    home: ["Haaland", "De Bruyne", "Foden", "Silva"],
    away: ["Messi",   "Suárez",    "Alba",   "Busquets"],
  },
  "match-004": {
    home: ["Álvarez", "Valdés",   "Fidalgo", "Zendejas"],
    away: ["Chicharito", "Vega",  "Antuna",  "Pizarro"],
  },
};

// ── Utilidades Fanout ────────────────────────────────────────────────────────

/**
 * Publica un evento SSE a un canal Fanout.
 * Todos los clientes suscritos a ese canal reciben el mensaje
 * instantáneamente, sin importar cuántos sean ni en qué POP de Fastly estén.
 */
async function publishToChannel(channel, eventType, data) {
  const ssePayload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

  const gripBody = {
    items: [
      {
        channel,
        formats: {
          "http-stream": {
            // Contenido SSE que se entrega a cada cliente suscrito
            content: ssePayload,
          },
        },
      },
    ],
  };

  const headers = { "Content-Type": "application/json" };
  if (!IS_LOCAL) {
    headers["Authorization"] = `Bearer ${FASTLY_API_TOKEN}`;
  }

  try {
    const res = await fetch(FANOUT_PUBLISH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(gripBody),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Fanout] Publish failed ${res.status}: ${text}`);
    } else {
      console.log(`[Fanout] ✅ Published "${eventType}" → channel "${channel}"`);
    }
  } catch (err) {
    console.error(`[Fanout] Publish error:`, err.message);
  }
}

/**
 * Publica el mismo evento a TODOS los canales relevantes:
 * - Canal del partido específico
 * - Canal "live-scores" global (dashboard general)
 */
async function publishMatchUpdate(matchId, eventType, data) {
  await Promise.all([
    publishToChannel(`match-${matchId}`, eventType, data),
    publishToChannel("live-scores",      eventType, { matchId, ...data }),
  ]);
}

// ── API REST ─────────────────────────────────────────────────────────────────

// Lista de partidos
app.get("/api/matches", (req, res) => {
  res.json({
    matches: Object.values(matches),
    publishEndpoint: IS_LOCAL
      ? "Pushpin local (localhost:5561)"
      : "Fastly Fanout API",
    totalSubscribers: "Ver en Fastly Dashboard",
  });
});

// Estado de un partido
app.get("/api/matches/:matchId", (req, res) => {
  const match = matches[req.params.matchId];
  if (!match) return res.status(404).json({ error: "Match not found" });
  res.json(match);
});

// ── SSE Handler local (para desarrollo sin Fastly) ───────────────────────────
// En producción, el edge Compute maneja esto con Fanout/GRIP
app.get("/stream/match/:matchId", (req, res) => {
  const match = matches[req.params.matchId];
  if (!match) return res.status(404).send("Match not found");

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Enviar estado inicial
  res.write(`event: init\ndata: ${JSON.stringify(match)}\n\n`);

  console.log(`[SSE] Client connected to match ${req.params.matchId}`);

  req.on("close", () => {
    console.log(`[SSE] Client disconnected from match ${req.params.matchId}`);
  });
});

app.get("/stream/live", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const allMatches = Object.values(matches);
  res.write(`event: init\ndata: ${JSON.stringify(allMatches)}\n\n`);

  console.log("[SSE] Client connected to live scores");
  req.on("close", () => console.log("[SSE] Client disconnected from live scores"));
});

// ── Simulador de partidos ────────────────────────────────────────────────────

function getRandomPlayer(matchId, team) {
  const teamPlayers = players[matchId]?.[team] ?? ["Jugador desconocido"];
  return teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
}

function simulateMatch(matchId) {
  const match = matches[matchId];
  if (!match || match.status === "finished") return;

  match.minute += 1;

  // Actualización de minuto
  if (match.minute % 5 === 0) {
    publishMatchUpdate(matchId, "clock", {
      matchId,
      minute: match.minute,
      homeScore: match.homeTeam.score,
      awayScore: match.awayTeam.score,
    });
  }

  // Eventos aleatorios
  const roll = Math.random();

  if (roll < 0.06) {
    // ⚽ GOL
    const scoringTeam = Math.random() < 0.5 ? "homeTeam" : "awayTeam";
    const scorer = getRandomPlayer(matchId, scoringTeam === "homeTeam" ? "home" : "away");
    match[scoringTeam].score += 1;

    const event = {
      type: "goal",
      matchId,
      minute: match.minute,
      team: match[scoringTeam].name,
      player: scorer,
      homeScore: match.homeTeam.score,
      awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
    };
    match.events.push(event);
    console.log(`⚽ GOL! ${scorer} (${match[scoringTeam].name}) min ${match.minute}`);
    publishMatchUpdate(matchId, "goal", event);

  } else if (roll < 0.10) {
    // 🟡 Tarjeta
    const cardTeam   = Math.random() < 0.5 ? "home" : "away";
    const cardPlayer = getRandomPlayer(matchId, cardTeam);
    const cardType   = Math.random() < 0.85 ? "yellow" : "red";

    const event = {
      type: "card",
      matchId,
      minute: match.minute,
      cardType,
      player: cardPlayer,
      team: cardTeam === "home" ? match.homeTeam.name : match.awayTeam.name,
    };
    match.events.push(event);
    console.log(`${cardType === "yellow" ? "🟡" : "🔴"} Tarjeta ${cardType} a ${cardPlayer}`);
    publishMatchUpdate(matchId, "card", event);

  } else if (roll < 0.14) {
    // 🔄 Sustitución
    const subTeam = Math.random() < 0.5 ? "home" : "away";
    const playerOut = getRandomPlayer(matchId, subTeam);
    const playerIn  = `Reserva #${Math.floor(Math.random() * 9) + 12}`;

    const event = {
      type: "substitution",
      matchId,
      minute: match.minute,
      playerOut,
      playerIn,
      team: subTeam === "home" ? match.homeTeam.name : match.awayTeam.name,
    };
    match.events.push(event);
    console.log(`🔄 Sustitución: ${playerOut} → ${playerIn}`);
    publishMatchUpdate(matchId, "substitution", event);
  }

  // Medio tiempo
  if (match.minute === 45) {
    publishMatchUpdate(matchId, "halftime", {
      matchId,
      homeScore: match.homeTeam.score,
      awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
    });
  }

  // Final del partido
  if (match.minute >= 90) {
    match.status = "finished";
    publishMatchUpdate(matchId, "fulltime", {
      matchId,
      homeScore: match.homeTeam.score,
      awayScore: match.awayTeam.score,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
    });
    console.log(`🏁 Fin del partido ${matchId}`);
  }
}

// ── Arrancar simulación ──────────────────────────────────────────────────────

function startSimulation() {
  const matchIds = Object.keys(matches);

  // Cada partido avanza a su propio ritmo (cada ~3-8 segundos demo = 1 minuto)
  matchIds.forEach((matchId, idx) => {
    const intervalMs = 3500 + idx * 800; // stagger entre partidos
    setInterval(() => simulateMatch(matchId), intervalMs);
    console.log(`⏱  Match ${matchId} simulando cada ${intervalMs}ms`);
  });
}

// ── Server ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Origin server corriendo en http://localhost:${PORT}`);
  console.log(`📡 Fanout publish endpoint: ${FANOUT_PUBLISH_URL}`);
  console.log(`🌐 Modo: ${IS_LOCAL ? "LOCAL (Pushpin)" : "PRODUCCIÓN (Fastly API)"}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/matches           → Lista de partidos`);
  console.log(`  GET  /api/matches/:id       → Partido específico`);
  console.log(`  GET  /stream/live           → SSE todos los partidos`);
  console.log(`  GET  /stream/match/:id      → SSE partido específico`);
  console.log(`\n⚽ Iniciando simulación de partidos...\n`);
  startSimulation();
});

