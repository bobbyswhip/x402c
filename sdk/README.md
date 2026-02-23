# x402c

TypeScript SDK for the x402c protocol on Base Mainnet.

## Install

```bash
npm install x402c viem
```

## Quick Start

```ts
import { createHubClient, createKeepAliveClient } from 'x402c';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({ chain: base, transport: http() });

// Hub — query endpoints and pricing
const hub = createHubClient({ publicClient });
const endpoints = await hub.getEndpoints();
const ethPrice = await hub.getEthPrice();

// KeepAlive — query subscriptions
const keepAlive = createKeepAliveClient({ publicClient });
const stats = await keepAlive.getStats();
```

## Clients

### `createHubClient({ publicClient, walletClient? })`

API marketplace — endpoints, requests, fulfillment, oracle pricing.

| Method | Description |
|--------|-------------|
| `getEndpoints()` | List all registered endpoints |
| `getEndpoint(id)` | Single endpoint details |
| `getEndpointPrice(id)` | Cost breakdown (base + markup + gas) |
| `getRequest(requestId)` | Request details + status |
| `getBalance(address)` | USDC deposit balance |
| `getEthPrice()` | Live ETH/USDC price from oracle |
| `estimateGasReimbursement(gasCostWei)` | Oracle gas cost in USDC |
| `watchRequests(callback)` | Poll for RequestCreated events (2s) |
| `depositUSDC(amount)` | Auto-approve + deposit |
| `createRequest(endpointId, params)` | Submit API request |
| `fulfillRequest(requestId, data, sessionId)` | Pre-flight + profitability + submit |
| `cancelRequest(requestId)` | Cancel timed-out request |

### `createKeepAliveClient({ publicClient, walletClient? })`

Recurring subscriptions — cron jobs for smart contracts.

| Method | Description |
|--------|-------------|
| `getSubscription(id)` | Subscription details |
| `getSubscriptionCost(id)` | Cost breakdown (fee, markup, gas, total) |
| `isReady(id)` | Check if subscription can be fulfilled |
| `getReadySubscriptions()` | All subscriptions where isReady() = true |
| `getStats()` | Volume, protocol fees, sub count, fulfillments |
| `getBalance(account)` | Consumer USDC deposit balance |
| `getEthPrice()` | Live ETH/USDC from oracle |
| `watchSubscriptions(callbacks)` | Real-time events (created, fulfilled, cancelled) |
| `depositUSDC(amount)` | Auto-approve + deposit |
| `createSubscription(params)` | Register a recurring job |
| `fulfill(subscriptionId)` | Pre-flight + profitability + submit |
| `pollAndFulfill(opts?)` | Auto-polling loop (10s default) |
| `cancelSubscription(id)` | Cancel and refund |

### `createSwapClient({ publicClient, walletClient? })`

Token trading via wASSOTC router.

| Method | Description |
|--------|-------------|
| `quoteEthToWass(ethAmount)` | Get swap quote |
| `buyX402C({ ethAmount, minTokenOut? })` | ETH -> wASS -> X402C |
| `buyWass({ ethAmount, minWassOut? })` | ETH -> wASS only |

### `createStakingClient({ publicClient, walletClient? })`

Stake X402C, earn rewards, agent eligibility.

| Method | Description |
|--------|-------------|
| `getStakeInfo(account)` | Stake, rewards, cooldown, slash history |
| `pendingRewards(account)` | Unclaimed rewards |
| `getReputation(agent)` | Agent reputation score |
| `isEligibleAgent(agent)` | Meets minimum stake? |
| `stake(amount)` | Auto-approve + stake |
| `requestUnstake(amount)` | Begin cooldown |
| `withdraw()` | Withdraw after cooldown |
| `claimRewards()` | Claim pending rewards |
| `compound()` | Re-stake rewards |

## Agent Example

```ts
import { createKeepAliveClient } from 'x402c';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount('0x...');
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({ account, chain: base, transport: http() });

const keepAlive = createKeepAliveClient({ publicClient, walletClient });

// Auto-fulfill ready subscriptions every 10s
const stop = keepAlive.pollAndFulfill({
  intervalMs: 10_000,
  onFulfilled: (subId, txHash) => console.log('Fulfilled', subId, txHash),
  onSkipped: (subId, reason) => console.log('Skipped', subId, reason),
});

// Watch for new subscriptions
keepAlive.watchSubscriptions({
  onCreated: (e) => console.log('New sub:', e.subscriptionId),
  onFulfilled: (e) => console.log('Cycle:', e.cycleNumber),
  onCancelled: (e) => console.log('Cancelled:', e.subscriptionId),
});
```

## Utilities

| Export | Description |
|--------|-------------|
| `withTxMutex(fn)` | Nonce mutex — serializes wallet writes |
| `checkTxProfitability(opts)` | Gas estimation + ETH price comparison |
| `createEventPoller(opts)` | getLogs polling with exponential backoff |

## ABIs

All contract ABIs are available as named exports:

```ts
import { HUB_ABI, KEEPALIVE_ABI, STAKING_ABI, ERC20_ABI, WASSOTC_ABI } from 'x402c';
// or
import { HUB_ABI } from 'x402c/abis';
```

## Constants

```ts
import { ADDRESSES, CHAIN_ID, X402C_POOL_KEY } from 'x402c';

ADDRESSES.HUB          // 0x54CE92b7170Df6761114113fB82d0E09941721Ab
ADDRESSES.KEEPALIVE    // 0x8b5f10E15f564A7BceaA402068edD94711d68cBF
ADDRESSES.STAKING      // 0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB
ADDRESSES.TOKEN        // 0x001373f663c235a2112A14e03799813EAa7bC6F1
ADDRESSES.USDC         // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
CHAIN_ID               // 8453 (Base Mainnet)
```

## License

MIT
