/// <reference types="@fastly/js-compute" />
import { createFanoutHandoff } from "fastly:fanout";

addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event) {
  const req = event.request;
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Health check — sin tocar Fanout
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", pop: "edge" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Rutas SSE → handoff a Fanout
  if (url.pathname === "/stream/live" || url.pathname.startsWith("/stream/match/")) {
    return createFanoutHandoff(req, "origin");
  }

  // Todo lo demás → proxy al origin con CORS
  try {
    const beresp = await fetch(req, { backend: "origin" });
    const headers = new Headers(beresp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(beresp.body, { status: beresp.status, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
