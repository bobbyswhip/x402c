/**
 * Hub Routes
 *
 * Monitoring, admin, and demo endpoints for the x402c hub contract.
 */

import { Router } from 'express';
import { type Address } from 'viem';
import {
  getRequest,
  getEndpoints,
  getContractBalance,
  getProtocolFees,
  pollPendingRequests,
  RequestStatus,
  getPublicClient,
  getHubAbi,
  getHubStats,
  getAgentStats,
  getCallbackInfo,
  flushProtocolFeesToBuyback,
} from '../services/hubService.js';
import { checkAndExecuteBuyback, getBuybackStats } from '../services/buybackService.js';
import { getBazaarResources, buildPaymentRequired, getEndpointById } from '../services/bazaarService.js';
import { getCached } from '../services/cacheService.js';

const router = Router();

console.log('[Hub Routes] Module loaded');

// Endpoint IDs used by SSE watcher for display label extraction
const ALCHEMY_TOKEN_PRICE_ENDPOINT_ID = '0x81a6c35d7fd200633cd9a5325818eb36af980d6c2f8dafefb1ad9cd0516a43db' as const;
const OPENSEA_FLOOR_PRICE_ENDPOINT_ID = '0xeaff7121cb2b1c649a1d0929191dbc4b5d3086c0f884a6ee68b211201930464e' as const;
const OPENSEA_BEST_OFFER_ENDPOINT_ID = '0x24014a894640637c9dbca0bbe5865a1123f7f0f2ed987030cb034d5674747561' as const;

// ════════════════════════════════════════════════════════════════════════
// Monitoring endpoints
// ════════════════════════════════════════════════════════════════════════

router.get('/requests', async (req, res) => {
  try {
    const statusFilter = req.query.status as string | undefined;

    // Serve from cache — requests are scanned during full refresh
    const cached = getCached<{ count: number; requests: any[] }>('hubRequests');
    if (cached && cached.requests) {
      let results = cached.requests;
      if (statusFilter) {
        results = results.filter((r: any) => r.status?.toLowerCase() === statusFilter.toLowerCase());
      }
      res.json({ count: results.length, requests: results });
      return;
    }

    // Fallback — cache not ready yet
    res.json({ count: 0, requests: [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

router.get('/requests/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await getRequest(requestId);

    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    // Decode responseData if present
    let responseDataDecoded: string | null = null;
    if (request.responseData && request.responseData !== '0x' && request.responseData.length > 2) {
      try {
        responseDataDecoded = Buffer.from(request.responseData.slice(2), 'hex').toString('utf8');
      } catch { /* leave null */ }
    }

    res.json({
      requestId: request.requestId,
      endpointId: request.endpointId,
      requester: request.requester,
      status: RequestStatus[request.status],
      statusCode: request.status,
      totalCostUnits: request.totalCostUnits.toString(),
      markupUnits: request.markupUnits.toString(),
      createdAt: new Date(Number(request.createdAt) * 1000).toISOString(),
      fulfilledBy: request.fulfilledBy,
      sessionId: request.sessionId,
      hasResponseData: request.responseData !== '0x' && request.responseData.length > 2,
      responseData: responseDataDecoded,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch request' });
  }
});

router.get('/balance/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const balance = await getContractBalance(address);
    res.json({
      address,
      balanceUnits: balance.toString(),
      balanceUsd: (Number(balance) / 1_000_000).toFixed(6),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

router.get('/endpoints', async (_req, res) => {
  try {
    const cached = getCached('hubEndpoints');
    if (cached) { res.json(cached); return; }
    const endpoints = await getEndpoints();
    res.json({
      count: endpoints.length,
      endpoints: endpoints.map(ep => {
        const baseCost = Number(ep.baseCostUnits);
        const markup = Math.min(baseCost * 0.1, 1_000_000); // 10% capped at $1
        const maxBytes = Number(ep.maxResponseBytes);
        return {
          id: ep.id,
          url: ep.url,
          inputFormat: ep.inputFormat,
          outputFormat: ep.outputFormat,
          baseCostUnits: ep.baseCostUnits.toString(),
          baseCostUsd: (baseCost / 1_000_000).toFixed(6),
          totalCost: (baseCost + markup).toFixed(0) + ' units',
          maxResponseBytes: maxBytes,
          callbackGasLimit: ep.callbackGasLimit.toString(),
          owner: ep.owner,
          active: ep.active,
        };
      }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to fetch endpoints', detail: msg });
  }
});

router.get('/stats', async (_req, res) => {
  try {
    const [endpoints, protocolFees, pending] = await Promise.all([
      getEndpoints(),
      getProtocolFees(),
      pollPendingRequests('hub-stats', 500n),
    ]);

    const fulfilled = pending.filter(r => r.status === RequestStatus.FULFILLED).length;
    const cancelled = pending.filter(r => r.status === RequestStatus.CANCELLED).length;

    res.json({
      hubContract: process.env.X402C_HUB_CONTRACT || 'not configured',
      endpointCount: endpoints.filter(e => e.active).length,
      protocolFeesAccumulated: protocolFees.toString(),
      protocolFeesUsd: (Number(protocolFees) / 1_000_000).toFixed(6),
      recentActivity: {
        pendingRequests: pending.filter(r => r.status === RequestStatus.PENDING).length,
        fulfilledRequests: fulfilled,
        cancelledRequests: cancelled,
      },
      agents: ['CoinGecko', 'Alchemy', 'OpenSea'],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// Demo endpoints — Contract-to-API demonstration
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /hub/demo/test — Debug test route
 */
router.get('/demo/test', (_req, res) => {
  res.json({
    ok: true,
    consumer: process.env.TEST_CONSUMER_CONTRACT || 'not set',
    hub: process.env.X402C_HUB_CONTRACT || 'not set',
    admin: process.env.ADMIN_WALLET ? 'set' : 'not set',
  });
});

// ════════════════════════════════════════════════════════════════════════
// Demo SSE watcher — user creates requests from their wallet (frontend),
// this endpoint monitors the request lifecycle in real-time.
// Admin-pays POST routes removed — users pay their own USDC.
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /hub/demo/watch/:requestId
 *
 * SSE stream that watches a request's lifecycle in real-time.
 * User creates the request from their wallet, then watches here.
 * Streams events: PENDING → FULFILLED (terminal success)
 */
router.get('/demo/watch/:requestId', async (req, res) => {
  const { requestId } = req.params;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let lastStatus = -1;
  let pollCount = 0;
  const maxPolls = 90; // 90 * 2s = 3 minutes max

  const interval = setInterval(async () => {
    pollCount++;
    try {
      const request = await getRequest(requestId);
      if (!request) {
        if (pollCount > 5) {
          send('log', { step: 0, status: 'error', message: 'Request not found onchain', timestamp: new Date().toISOString() });
          clearInterval(interval);
          res.end();
        }
        return;
      }

      const statusCode = request.status;

      // Only send updates when status changes
      if (statusCode === lastStatus) return;
      lastStatus = statusCode;

      if (statusCode === RequestStatus.PENDING) return; // frontend already shows waiting message

      if (statusCode === RequestStatus.FULFILLED) {
        send('log', {
          step: 3,
          status: 'success',
          message: 'Agent fulfilled request — data written onchain via callback.',
          timestamp: new Date().toISOString(),
        });
        send('log', {
          step: 4,
          status: 'info',
          message: `Fulfilled by agent: ${request.fulfilledBy}`,
          timestamp: new Date().toISOString(),
        });

        // Look up the fulfillment TX hash from RequestFulfilled event
        let fulfillTxHash: string | null = null;
        try {
          const pc = getPublicClient();
          const hubAddress = process.env.X402C_HUB_CONTRACT as Address;
          const currentBlock = await pc.getBlockNumber();
          const logs = await pc.getLogs({
            address: hubAddress,
            event: {
              type: 'event',
              name: 'RequestFulfilled',
              inputs: [
                { name: 'requestId', type: 'bytes32', indexed: true },
                { name: 'agent', type: 'address', indexed: true },
                { name: 'sessionId', type: 'bytes32', indexed: false },
              ],
            },
            args: { requestId: requestId as `0x${string}` },
            fromBlock: currentBlock - 100n,
            toBlock: 'latest',
          });
          if (logs.length > 0) {
            fulfillTxHash = logs[0].transactionHash;
          }
        } catch { /* best effort */ }

        send('log', {
          step: 5,
          status: 'success',
          message: fulfillTxHash
            ? `Fulfillment TX: ${fulfillTxHash.slice(0, 14)}...`
            : 'Response stored onchain — read from contract.',
          timestamp: new Date().toISOString(),
        });

        send('complete', {
          requestId,
          status: 'FULFILLED',
          sessionId: request.sessionId,
          fulfilledBy: request.fulfilledBy,
          fulfillTxHash,
        });

        clearInterval(interval);
        res.end();
      }

      if (statusCode === RequestStatus.CANCELLED) {
        send('log', {
          step: 6,
          status: 'error',
          message: 'Request was cancelled (timeout)',
          timestamp: new Date().toISOString(),
        });
        send('complete', { requestId, status: 'CANCELLED' });
        clearInterval(interval);
        res.end();
      }
    } catch (error) {
      console.error('[Demo] Watch poll error:', error);
    }

    if (pollCount >= maxPolls) {
      send('log', { step: 0, status: 'error', message: 'Watch timeout — no fulfillment within 3 minutes', timestamp: new Date().toISOString() });
      clearInterval(interval);
      res.end();
    }
  }, 2000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Hub stats, agent stats, buyback control
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /hub/v2/stats — Global hub protocol statistics
 */
router.get('/v2/stats', async (_req, res) => {
  try {
    const cached = getCached('hubV2Stats');
    if (cached) { res.json(cached); return; }
    const stats = await getHubStats();
    if (!stats) {
      res.status(503).json({ error: 'Hub stats unavailable' });
      return;
    }

    res.json({
      hubContract: process.env.X402C_HUB_CONTRACT || 'not configured',
      buybackModule: process.env.X402C_BUYBACK_MODULE || 'not configured',
      totalVolumeUSDC: stats.volume.toString(),
      totalVolumeUsd: (Number(stats.volume) / 1_000_000).toFixed(6),
      totalProtocolFeesUSDC: stats.protocolFees.toString(),
      totalProtocolFeesUsd: (Number(stats.protocolFees) / 1_000_000).toFixed(6),
      pendingFeesUSDC: stats.pendingFees.toString(),
      pendingFeesUsd: (Number(stats.pendingFees) / 1_000_000).toFixed(6),
      endpointCount: Number(stats.endpointCount),
      totalRequestsServed: Number(stats.requestsServed),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch v2 stats' });
  }
});

/**
 * GET /hub/v2/agent/:address — Per-agent earnings and stats
 */
router.get('/v2/agent/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const stats = await getAgentStats(address);
    if (!stats) {
      res.status(404).json({ error: 'Agent stats unavailable' });
      return;
    }

    res.json({
      agent: address,
      earningsUSDC: stats.earnings.toString(),
      earningsUsd: (Number(stats.earnings) / 1_000_000).toFixed(6),
      fulfillCount: Number(stats.fulfillCount),
      isRegistered: stats.isRegistered,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch agent stats' });
  }
});

/**
 * GET /hub/v2/callback/:requestId — Callback info for a request
 */
router.get('/v2/callback/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const callback = await getCallbackInfo(requestId);
    if (!callback) {
      res.status(404).json({ error: 'Callback info unavailable' });
      return;
    }

    res.json({
      requestId,
      gasLimit: callback.gasLimit.toString(),
      executed: callback.executed,
      success: callback.success,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch callback info' });
  }
});

/**
 * POST /hub/v2/buyback — Admin trigger: flush fees to buyback module
 */
router.post('/v2/buyback', async (_req, res) => {
  try {
    const stats = await getHubStats();
    if (!stats) {
      res.status(503).json({ error: 'Hub stats unavailable' });
      return;
    }

    if (stats.pendingFees === 0n) {
      res.json({
        success: true,
        flushedUSDC: '0',
        message: 'No pending fees to flush',
      });
      return;
    }

    const txHash = await flushProtocolFeesToBuyback();
    if (txHash) {
      res.json({
        success: true,
        flushedUSDC: stats.pendingFees.toString(),
        usdcFlush: txHash,
        message: `Flushed ${stats.pendingFees} USDC units to buyback`,
      });
    } else {
      res.json({
        success: false,
        flushedUSDC: '0',
        pendingFees: stats.pendingFees.toString(),
        message: 'Flush TX failed. Buyback module may not recognize this hub. Call setHub() on the buyback module via governance.',
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Buyback flush failed', detail: msg });
  }
});

// ════════════════════════════════════════════════════════════════════════
// x402 Bazaar — Service discovery for agent-to-agent commerce
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /hub/bazaar/resources — List all discoverable endpoints
 *
 * Returns x402 Bazaar-compatible resource list.
 * External agents query this (or CDP facilitator catalogs it)
 * to discover our paid API endpoints.
 */
router.get('/bazaar/resources', async (_req, res) => {
  try {
    const cached = getCached('bazaar');
    if (cached) { res.json(cached); return; }
    const resources = await getBazaarResources();
    res.json(resources);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bazaar resources' });
  }
});

/**
 * GET /hub/api/:endpointId — x402 protected endpoint
 *
 * Without X-PAYMENT header: returns 402 with payment requirements + Bazaar discovery
 * With valid X-PAYMENT: processes the request (future: verify payment inline)
 *
 * This is the canonical URL that agents discover via Bazaar.
 */
router.get('/api/:endpointId', async (req, res) => {
  const { endpointId } = req.params;
  const paymentHeader = req.headers['x-payment'] as string | undefined;

  const endpoint = await getEndpointById(endpointId);
  if (!endpoint || !endpoint.active) {
    res.status(404).json({ error: 'Endpoint not found or inactive' });
    return;
  }

  // No payment → return 402 with Bazaar discovery metadata
  if (!paymentHeader) {
    const paymentRequired = buildPaymentRequired(endpoint);
    res.status(402).json(paymentRequired);
    return;
  }

  // Payment provided → acknowledge (full inline verification is future work)
  // For now, agents use the hub contract's createRequest/fulfillRequest flow
  res.json({
    message: 'Payment received. Use hub contract createRequest() for onchain fulfillment.',
    endpointId,
    hubContract: process.env.X402C_HUB_CONTRACT,
    endpoint: {
      url: endpoint.url,
      inputFormat: endpoint.inputFormat,
      outputFormat: endpoint.outputFormat,
      baseCostUnits: endpoint.baseCostUnits.toString(),
    },
  });
});

/**
 * POST /hub/api/:endpointId — x402 protected endpoint (POST variant)
 *
 * Same as GET but for POST-based endpoints (Alchemy JSON-RPC, token prices).
 */
router.post('/api/:endpointId', async (req, res) => {
  const { endpointId } = req.params;
  const paymentHeader = req.headers['x-payment'] as string | undefined;

  const endpoint = await getEndpointById(endpointId);
  if (!endpoint || !endpoint.active) {
    res.status(404).json({ error: 'Endpoint not found or inactive' });
    return;
  }

  if (!paymentHeader) {
    const paymentRequired = buildPaymentRequired(endpoint);
    res.status(402).json(paymentRequired);
    return;
  }

  res.json({
    message: 'Payment received. Use hub contract createRequest() for onchain fulfillment.',
    endpointId,
    hubContract: process.env.X402C_HUB_CONTRACT,
    endpoint: {
      url: endpoint.url,
      inputFormat: endpoint.inputFormat,
      outputFormat: endpoint.outputFormat,
      baseCostUnits: endpoint.baseCostUnits.toString(),
    },
  });
});

/**
 * GET /hub/v2/buyback/stats — Buyback module stats (50/50 staking + hook)
 */
router.get('/v2/buyback/stats', async (_req, res) => {
  try {
    const cached = getCached('buybackV2');
    if (cached) { res.json(cached); return; }
    const { createPublicClient: createClient, http: httpTransport, parseAbi, formatUnits } = await import('viem');
    const { base: baseChain } = await import('viem/chains');

    const buybackV2 = (process.env.X402C_BUYBACK_V2 || '0xa5Fcf30dcf47B684ecaCBB521316bFD2C50A6A26') as `0x${string}`;
    const client = createClient({ chain: baseChain, transport: httpTransport(process.env.BASE_RPC_URL || 'https://mainnet.base.org') });

    const abi = parseAbi([
      'function getStats() view returns (uint256 usdcConverted, uint256 ethConverted, uint256 tokensDistributed, uint256 pendingUSDC, uint256 pendingETH)',
    ]);

    const result = await client.readContract({ address: buybackV2, abi, functionName: 'getStats' }) as readonly [bigint, bigint, bigint, bigint, bigint];
    const [usdcConverted, ethConverted, tokensDistributed, pendingUSDC, pendingETH] = result;

    res.json({
      buybackV2Contract: buybackV2,
      usdcConverted: usdcConverted.toString(),
      usdcConvertedFormatted: `$${formatUnits(usdcConverted, 6)}`,
      ethConverted: ethConverted.toString(),
      ethConvertedFormatted: `${formatUnits(ethConverted, 18)} ETH`,
      tokensDistributed: tokensDistributed.toString(),
      tokensDistributedFormatted: `${formatUnits(tokensDistributed, 18)} X402C`,
      pendingUSDC: pendingUSDC.toString(),
      pendingUSDCFormatted: `$${formatUnits(pendingUSDC, 6)}`,
      pendingETH: pendingETH.toString(),
      pendingETHFormatted: `${formatUnits(pendingETH, 18)} ETH`,
      splitDescription: '50% staking + 50% hook donate',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: 'Failed to fetch buyback v2 stats', detail: msg });
  }
});

export default router;
