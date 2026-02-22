# X402C Protocol

Build smart contracts that call any API. X402C is a decentralized API marketplace on Base where your contract can request off-chain data and receive verified responses via callback — paid in USDC with a single transaction.

## Quick Start

### 1. Install

```bash
npm install @openzeppelin/contracts
```

Copy `contracts/X402CConsumerBase.sol` and `contracts/interfaces/IX402CConsumer.sol` into your project.

### 2. Write Your Consumer

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./X402CConsumerBase.sol";

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IX402CHub {
    function depositUSDC(uint256 amount) external;
    function createRequestWithCallback(
        bytes32 endpointId,
        bytes calldata params
    ) external returns (bytes32 requestId);
    function getEndpointPrice(bytes32 id) external view returns (
        uint256 total,
        uint256 totalWithCallback
    );
    function getBalance(address account) external view returns (uint256);
}

contract MyConsumer is X402CConsumerBase {
    IX402CHub public immutable hubContract;
    IERC20 public immutable usdc;

    mapping(bytes32 => string) public responses;

    constructor(address _hub, address _usdc) X402CConsumerBase(_hub) {
        hubContract = IX402CHub(_hub);
        usdc = IERC20(_usdc);
    }

    /// @notice Request API data. Caller must approve USDC to this contract first.
    function request(bytes32 endpointId, bytes calldata params) external returns (bytes32) {
        (, uint256 cost) = hubContract.getEndpointPrice(endpointId);

        uint256 balance = hubContract.getBalance(address(this));
        if (balance < cost) {
            uint256 needed = cost - balance;
            usdc.transferFrom(msg.sender, address(this), needed);
            usdc.approve(hub, needed);
            hubContract.depositUSDC(needed);
        }

        return hubContract.createRequestWithCallback(endpointId, params);
    }

    /// @notice Called by the hub when your request is fulfilled.
    function _onFulfilled(bytes32 requestId, bytes calldata data) internal override {
        responses[requestId] = string(data);
    }
}
```

### 3. Deploy

Deploy your consumer with:
- `_hub`: `0x46048903457eA7976Aab09Ab379b52753531F08C` (X402C Hub on Base)
- `_usdc`: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)

### 4. Use It

```
1. User approves USDC to your consumer contract (one-time)
2. User calls request(endpointId, params)         — single TX
3. Agent picks up request, calls API, submits data — automatic
4. Hub calls your _onFulfilled() with the result   — automatic
5. Read responses[requestId] on-chain
```

## How It Works

```
Your Contract                        X402C Hub                         Agent
      |                                 |                                |
      |-- request(endpoint, params) --> |                                |
      |   (pulls USDC, deposits,        |                                |
      |    creates request)             |-- emits RequestCreated ------->|
      |                                 |                     calls API  |
      |                                 |<-- fulfillRequest(data) ------|
      |<-- _onFulfilled(id, data) ----- |                                |
      |                                 |-- pays agent USDC ----------->|
```

## Security & Trust Model

X402C is designed so that **no single party can steal funds, manipulate data, or grief other participants**. Every external call is isolated, every payment is ordered defensively, and every role has bounded authority.

### Architecture Security Summary

```
Consumer Contract          X402C Hub (nonReentrant)              Agent Wallet
      |                          |                                    |
      |-- request + USDC ------->|  balance deducted BEFORE           |
      |                          |  request is created                |
      |                          |                                    |
      |                          |-- RequestCreated event ----------->|
      |                          |                                    |
      |                          |<-- fulfillRequest(data) -----------|
      |                          |                                    |
      |                          |  1. validate (status, size, owner) |
      |                          |  2. mark FULFILLED (state first)   |
      |                          |  3. pay agent USDC                 |
      |                          |  4. try callback { gas: limit }    |
      |                          |     catch { success = false }      |
      |                          |                                    |
      |<-- _onFulfilled() -------|  callback isolated — can't break   |
      |    (gas-limited,         |  fulfillment or agent payment      |
      |     try/catch wrapped)   |                                    |
```

### Callback Isolation

The most common concern: *"Can a malicious consumer contract exploit the callback to steal from agents?"*

**No.** Here's why:

| Protection | How It Works |
|-----------|--------------|
| **Fees paid before callback** | `_distributeFees()` runs before `_executeCallback()`. Agent is paid regardless of callback outcome. |
| **try/catch wrapping** | Callback reverts are caught silently. A failing callback sets `success = false` but does not revert the fulfillment. |
| **Explicit gas limit** | Callback runs with `{gas: endpoint.callbackGasLimit}` — agent controls this value per endpoint. Infinite loops, storage bombs, and expensive computation are all bounded. |
| **nonReentrant guard** | `fulfillRequest()` is protected by a reentrancy lock. Callback cannot re-enter the hub to double-fulfill, double-cancel, or manipulate state. |
| **msg.sender = hub** | Inside the callback, `msg.sender` is the hub contract, not the agent wallet. A malicious callback cannot call `transferFrom(tx.origin, ...)` because the agent never approved the consumer contract for anything. |

**Callback failure does not affect agent payment.** The hub stores `callbackSuccess = true/false` for transparency, but the request is `FULFILLED` and the agent is paid either way.

### Payment Safety (Checks-Effects-Interactions)

All payment flows follow the checks-effects-interactions pattern to prevent reentrancy and state manipulation:

**Request creation:**
1. Validate endpoint exists and is active
2. Calculate cost via oracle
3. **Deduct balance** from consumer (effect)
4. Create request struct (effect)
5. Emit event (no external call)

**Fulfillment:**
1. Validate request is PENDING, caller is endpoint owner, response fits size limit
2. **Mark request FULFILLED** (effect — before any external call)
3. Transfer USDC to agent and protocol (interaction — state already final)
4. Execute callback in try/catch (interaction — isolated)

**Cancellation:**
1. Validate request is PENDING and timed out
2. **Mark request CANCELLED** (effect)
3. Refund consumer balance (effect — internal bookkeeping)
4. Transfer canceller share (interaction)

### Agent Protection

Agents are the fulfillment layer — they stake tokens, watch for requests, and submit API responses. The protocol protects them from:

| Attack Vector | Mitigation |
|--------------|------------|
| **Callback griefing** | Gas-limited + try/catch. Callback can waste at most `callbackGasLimit` gas (~$0.06 at 2M gas on Base). Agent is already paid. |
| **Stealth approvals** in callback | `msg.sender` inside callback = hub, not agent. Agent wallet has no token approvals to the consumer. `tx.origin` attacks fail because agent never approved consumer contract. |
| **Double fulfillment** | Hub checks `status == PENDING` before allowing fulfillment. Second call reverts. |
| **Unprofitable requests** | Agent runs pre-flight `estimateGas()` + profitability check before submitting. Skips if gas cost exceeds reimbursement. |
| **Gas estimation attacks** | Agent adds 20% buffer over estimate. Response size is bounded by `maxResponseBytes` (hub reverts if exceeded). |
| **Slashing abuse** | Only authorized slashers (hub, governance timelock, dispute resolver) can slash. Slash amount capped at agent's stake. |

### Consumer Protection

Consumers deposit USDC and create requests. The protocol protects them from:

| Attack Vector | Mitigation |
|--------------|------------|
| **Agent never fulfills** | Requests auto-expire after timeout. Consumer gets 90% refund on cancellation (gas reimbursement + 90% of API cost). |
| **Agent submits garbage data** | Dispute resolution system — consumer stakes 100 X402C bond to challenge. If upheld, agent is slashed 50% and bond is returned. |
| **Overcharging** | Pricing is transparent — `getEndpointPrice()` returns exact cost before request. Oracle-based gas pricing tracks real ETH/USDC rates. |
| **Response too large (gas bomb)** | Hub enforces `maxResponseBytes` per endpoint. Oversized responses are rejected before callback. |
| **Funds locked forever** | Cancel + refund path exists for timed-out requests. Owner can recover stuck tokens via emergency functions. |

### Access Control

The protocol uses a layered permission model — no single key can do everything:

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| **Owner** | Transfer ownership, add/remove admins, emergency recovery | Fulfill requests, access consumer funds, bypass reentrancy guards |
| **Admin** | Register agents, set protocol config, flush fees to buyback | Directly move consumer deposits, override request outcomes |
| **Agent** | Register endpoints, fulfill their own requests, update their pricing | Fulfill other agents' requests, access protocol fees, modify other endpoints |
| **Consumer** | Deposit USDC, create requests, file disputes | Withdraw other consumers' funds, bypass payment requirements |
| **Governance (Timelock)** | Execute voted proposals after 24h delay, manage staking/buyback config | Bypass timelock delay, unilaterally change contracts |

### Staking & Slashing

Agents stake X402C tokens as collateral for good behavior:

- **Slash triggers**: Only bad data (failed sanity check) or upheld disputes. Timeouts are NOT slashable — agents just lose reputation.
- **Slash distribution**: 50% to staker reward pool, 50% donated to V4 liquidity hook — prevents any single party from profiting off slashes.
- **Cooldown period**: Unstaking requires a cooldown, preventing agents from front-running an incoming slash by withdrawing.
- **Authorized slashers only**: Hub contract, governance timelock, and dispute resolver are the only addresses that can trigger slashes.

### Dispute Resolution

Consumers can challenge agent responses through on-chain disputes:

1. Consumer stakes **100 X402C bond** and opens dispute with evidence
2. Resolver has **3 days** to review
3. **Upheld**: Agent slashed 50%, consumer bond returned
4. **Rejected**: Bond split 50/50 between staker rewards and liquidity
5. **Unresolved after 10 days**: Consumer reclaims bond automatically (grace period protection)

The bond requirement prevents spam disputes, and the grace period ensures consumers can't lose their bond to resolver inaction.

### Oracle & Pricing

Gas reimbursement uses a Uniswap V2 price oracle (`getAmountsOut`) for real-time ETH/USDC conversion:

- **Admin sets gas cost in wei** per endpoint (based on observed callback gas usage)
- **Oracle converts wei to USDC** at current market rate
- **Snapshot pricing**: Gas reimbursement is calculated at request creation and locked — price swings between request and fulfillment don't affect the agent or consumer
- **Admin can swap oracle**: `setPriceOracle()` allows upgrading to V3 TWAP or Chainlink without redeploying the hub

### Known Limitations & Transparency

| Limitation | Status | Mitigation |
|-----------|--------|------------|
| **V2 oracle (no TWAP)** | Uses spot price, not time-weighted average | Snapshot pricing locks cost at request time. Oracle is swappable — V3 TWAP or Chainlink can be plugged in. |
| **Owner emergency powers** | Owner can recover tokens, add admins | Ownership transferred to governance timelock (24h delay). All changes are public and on-chain. |
| **Agents see request params** | Agents must read params to call APIs | Architectural requirement — agents need params to fetch data. ZK commitment proves data integrity post-response. |
| **Callback failures are silent** | Consumer callback can fail without notification | `callbackSuccess` is stored on-chain and emitted as `CallbackExecuted` event. Consumers should monitor this. |
| **Single-block oracle reads** | Flash loan could theoretically manipulate gas pricing | Impact is bounded — gas reimbursement is a small fraction of request cost ($0.01-$0.02). Manipulation profit is negligible. |

### Best Practices for Consumer Developers

```solidity
// DO: Inherit X402CConsumerBase for callback routing + onlyHub protection
contract MyConsumer is X402CConsumerBase { ... }

// DO: Keep _onFulfilled() simple — store data, emit event, done
function _onFulfilled(bytes32 requestId, bytes calldata data) internal override {
    responses[requestId] = data;
    emit Fulfilled(requestId);
}

// DO: Check cost before requesting
(, uint256 cost) = hub.getEndpointPrice(endpointId);

// DON'T: Make external calls in _onFulfilled() — callback gas is limited
// DON'T: Assume callback always succeeds — check callbackSuccess on-chain
// DON'T: Store massive response data — each byte costs gas in the callback
```

### Best Practices for Agent Operators

1. **Set `callbackGasLimit` conservatively** — 2M gas covers most use cases. Lower = less risk per callback.
2. **Set `maxResponseBytes` tightly** — don't allow 10KB responses if your API returns 200 bytes. Smaller = cheaper callbacks.
3. **Run pre-flight gas estimation** — simulate fulfillment before submitting to catch reverts early.
4. **Monitor profitability** — compare gas reimbursement to actual TX cost. Skip requests that lose money.
5. **Stake proportionally** — your stake is your collateral. More stake = higher reputation, but more at risk if slashed.

### Verified Contracts

All protocol contracts are **verified and open-source** on Basescan. Every function, modifier, and state variable is publicly readable:

- [X402C Hub](https://basescan.org/address/0x46048903457eA7976Aab09Ab379b52753531F08C#code) — Core request/fulfill/callback logic
- [X402C Staking](https://basescan.org/address/0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB#code) — Agent stake, slash, and rewards
- [X402C Dispute Resolver](https://basescan.org/address/0x27798a59635fb3E3F9e3373BDCAC8a78a43496bE#code) — Consumer challenge system
- [X402C Price Oracle](https://basescan.org/address/0xdc5c2E4316f516982c9caAC4d28827245e89bf53#code) — ETH/USDC gas pricing
- [X402C Governor](https://basescan.org/address/0x9b9CB431002685aEF9A3f5203A8FF5DB8A8c5781#code) — DAO governance
- [X402C Token](https://basescan.org/address/0x001373f663c235a2112A14e03799813EAa7bC6F1#code) — ERC20Votes governance token

## Pricing

Pricing is **dynamic and set by each agent** who registers an endpoint. There is no fixed protocol fee — agents compete on price.

Each endpoint has:
- **Base cost** — the agent's price for the API call (fractions of a cent)
- **Gas reimbursement** — covers the on-chain callback TX cost, calculated via a live ETH/USDC oracle

Call `hub.getEndpointPrice(endpointId)` on-chain to get the exact cost before making a request. It returns both the non-callback price and the callback-inclusive price in USDC (6 decimals).

Agents set their own pricing when registering endpoints. Cheaper agents attract more traffic. The marketplace is permissionless — anyone can register an endpoint and set competitive rates.

## Available Endpoints

| Endpoint ID | Name | Description |
|-------------|------|-------------|
| `0x81a6c35d...` | Alchemy Token Price | Get token prices via Alchemy API |
| `0x15772e06...` | OpenSea Listings | Get NFT collection listings |

Browse all endpoints at [x402c.org/hub](https://x402c.org/hub).

## Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| **X402C Hub** | [`0x46048903457eA7976Aab09Ab379b52753531F08C`](https://basescan.org/address/0x46048903457eA7976Aab09Ab379b52753531F08C) |
| **USDC** | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| X402C Token | [`0x001373f663c235a2112A14e03799813EAa7bC6F1`](https://basescan.org/address/0x001373f663c235a2112A14e03799813EAa7bC6F1) |
| Demo Consumer | [`0xC707AB8905865f1E97f5CaBf3d2ae798dcb7827a`](https://basescan.org/address/0xC707AB8905865f1E97f5CaBf3d2ae798dcb7827a) |

## Files

```
contracts/
  X402CConsumerBase.sol       # Inherit this — handles hub callback routing
  X402CDemoConsumer.sol        # Full working example (single-TX pattern)
  interfaces/
    IX402CConsumer.sol         # Callback interface your contract implements
```

- **`X402CConsumerBase`** — Abstract base contract. Inherit it, implement `_onFulfilled()`, done.
- **`X402CDemoConsumer`** — Production example with USDC handling, response storage, and recovery functions. Copy and modify for your use case.

## Building an Agent

Agents fulfill requests by watching hub events and submitting API responses.

1. **Stake** X402C tokens via the [Staking contract](https://basescan.org/address/0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB)
2. **Register** an endpoint on the Hub — set your API URL, base cost, and gas config
3. **Watch** for `RequestCreated` events matching your endpoint ID
4. **Fetch** the API data using the request parameters
5. **Submit** via `hub.fulfillRequest(requestId, responseData)`
6. **Get paid** in USDC automatically on fulfillment

Agent docs and backend reference coming soon.

## License

MIT
