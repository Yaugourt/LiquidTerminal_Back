#!/usr/bin/env node
/**
 * Diagnostic script for liquidation pipeline
 * Run: node scripts/diagnose-liquidations.mjs
 *
 * Checks:
 * 1. Backend API reachability (WS + HTTP)
 * 2. WebSocket connection and subscription
 * 3. SSE stream (fallback)
 *
 * Usage:
 *   API_URL=https://liquidterminal.up.railway.app node scripts/diagnose-liquidations.mjs
 *   API_URL=https://api.liquidterminal.xyz node scripts/diagnose-liquidations.mjs
 */

const API_URL = process.env.API_URL || process.env.LIQUIDATION_API_URL || 'https://liquidterminal.up.railway.app';

async function main() {
  console.log('\n=== Liquidations Pipeline Diagnostic ===\n');
  console.log('API_URL:', API_URL);
  console.log('');

  // 1. Health check
  try {
    const healthRes = await fetch(`${API_URL}/health`);
    const health = await healthRes.json();
    console.log('✅ Health:', healthRes.status, JSON.stringify(health, null, 2).slice(0, 200));
  } catch (e) {
    console.log('❌ Health FAILED:', e.message);
  }

  // 2. SSE stream stats
  try {
    const statsRes = await fetch(`${API_URL}/liquidations/stream/stats`);
    const stats = await statsRes.json();
    console.log('\n✅ SSE /liquidations/stream/stats:', JSON.stringify(stats, null, 2));
  } catch (e) {
    console.log('\n❌ SSE stats FAILED:', e.message);
  }

  // 3. WebSocket connection test
  const WebSocket = (await import('ws')).default;
  const wsUrl = API_URL.replace(/^http/, 'ws') + '/ws';

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log('\n⏱️  WS: 10s timeout - no liquidation received (normal if market quiet)');
      ws.close();
      resolve();
    }, 10000);

    const ws = new WebSocket(wsUrl);
    let subscribed = false;

    ws.on('open', () => {
      console.log('\n✅ WebSocket connected to', wsUrl);
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'liquidation', filters: {} }
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connected') {
        console.log('   → received connected, clientId:', msg.data?.clientId);
      }
      if (msg.type === 'subscribed') {
        subscribed = true;
        console.log('   → subscribed to liquidations');
      }
      if (msg.type === 'liquidation') {
        clearTimeout(timeout);
        console.log('\n✅ LIQUIDATION RECEIVED:', JSON.stringify(msg.data, null, 2).slice(0, 500));
        ws.close();
        resolve();
      }
      if (msg.type === 'heartbeat') {
        console.log('   → heartbeat');
      }
    });

    ws.on('error', (err) => {
      console.log('\n❌ WebSocket error:', err.message);
      clearTimeout(timeout);
      resolve();
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!subscribed) {
        console.log('\n⚠️  WebSocket closed before subscription confirmed');
      }
      resolve();
    });
  });

  console.log('\n=== Diagnostic complete ===\n');
}

main().catch(console.error);
