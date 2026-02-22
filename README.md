# X402C Protocol

On-chain API calls paid in USDC. Your contract requests off-chain data, an agent fetches it and submits the response, the hub callbacks your contract with the result. One transaction from the user's perspective.

## Quick start

### 1. Install

```bash
npm install @openzeppelin/contracts
```

Copy `contracts/X402CConsumerBase.sol` and `contracts/interfaces/IX402CConsumer.sol` into your project.

### 2. Write your consumer

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

### 4. Use it

```
1. User approves USDC to your consumer contract (one-time)
2. User calls request(endpointId, params)         — single TX
3. Agent picks up request, calls API, submits data — automatic
4. Hub calls your _onFulfilled() with the result   — automatic
5. Read responses[requestId] on-chain
```

## How it works

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

## Security

### Fulfillment ordering

The hub processes fulfillment in this order:

1. Validate: request is PENDING, caller owns the endpoint, response fits `maxResponseBytes`
2. State change: mark request `FULFILLED`
3. Pay agent: transfer USDC to agent and protocol
4. Callback: call consumer's `_onFulfilled()` inside try/catch with gas cap

State changes happen before external calls. Agent payment happens before callback. If the callback reverts, the agent is still paid and the request is still fulfilled.

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
      |<-- _onFulfilled() -------|  callback can't break fulfillment  |
      |    (gas-limited,         |  or reverse agent payment          |
      |     try/catch wrapped)   |                                    |
```

### Callback safety

The callback runs with `msg.sender = hub`, not the agent wallet. The call chain:

```
Agent wallet -> fulfillRequest() -> Hub -> x402cCallback() -> Consumer contract
                 msg.sender           msg.sender
                 = agent              = hub (not agent)
```

A malicious callback cannot drain the agent. `transferFrom(tx.origin, ...)` fails because the agent never approved the consumer contract. The agent has no token relationship with the consumer.

The callback has a hard gas cap set by the agent (`endpoint.callbackGasLimit`). Infinite loops and storage bombs hit this cap and stop. `nonReentrant` on `fulfillRequest()` prevents the callback from re-entering the hub.

### Agent risks

| Risk | Protection |
|------|-----------|
| Callback wastes gas | Capped at `callbackGasLimit` (~$0.06 at 2M gas on Base). Agent already paid. |
| Callback sneaks in `approve()` | `msg.sender` = hub, not agent. Agent never approved consumer for anything. |
| Double fulfillment | Hub requires `status == PENDING`. Second call reverts. |
| Unprofitable request | Agent simulates with `estimateGas()` + profitability check before submitting. |
| Slashing | Only hub, governance timelock, and dispute resolver can slash. Capped at staked amount. |

### Consumer risks

| Risk | Protection |
|------|-----------|
| Agent doesn't respond | 5-minute timeout. Anyone can cancel. Consumer gets 100% gas reimbursement + 90% API cost back. |
| Agent sends bad data | Dispute system: stake 100 X402C bond, resolver reviews in 3 days. Upheld = agent slashed 50%, bond returned. |
| Overcharging | `getEndpointPrice()` returns exact USDC cost before request. Compare across agents. |
| Oversized response | Hub rejects responses exceeding `maxResponseBytes` before callback runs. |

### Access control

| Role | Can | Cannot |
|------|-----|--------|
| Owner | Add/remove admins, emergency token recovery | Fulfill requests, touch consumer balances |
| Admin | Register agents, configure protocol settings | Move consumer deposits, override outcomes |
| Agent | Register endpoints, fulfill own requests, set pricing | Fulfill other agents' requests, access protocol fees |
| Consumer | Deposit USDC, create requests, file disputes | Withdraw other consumers' funds |
| Governance (timelock) | Execute proposals after 24h delay | Skip delay, change contracts directly |

Ownership is behind a 24-hour governance timelock. Config changes are visible on-chain before they execute.

### Staking

Agents stake X402C tokens as collateral. Slashing happens on bad data (failed sanity check) or upheld disputes. Timeouts are not slashable, they only reduce reputation.

Slash proceeds split 50/50: staker reward pool and V4 liquidity hook. Unstaking has a cooldown so agents can't withdraw before a pending slash lands.

### Disputes

1. Consumer stakes 100 X402C bond, opens dispute with evidence
2. Resolver reviews within 3 days
3. Upheld: agent slashed 50%, bond returned
4. Rejected: bond splits 50/50 (staker rewards + liquidity)
5. No resolution in 10 days: consumer reclaims bond automatically

### Gas pricing

A Uniswap V2 oracle converts the endpoint's gas cost (set in wei by the admin) to USDC at the current ETH price. The cost is snapshotted at request creation, so ETH price movement between request and fulfillment doesn't affect either party.

The oracle is swappable via `setPriceOracle()` without redeploying the hub.

### Known limitations

- **V2 spot oracle**: No TWAP. Flash loan manipulation is theoretically possible but gas reimbursement is $0.01-0.02 per request, making it unprofitable. Oracle is swappable.
- **Owner emergency powers**: Behind 24h governance timelock. All actions visible on-chain before execution.
- **Agents see request params**: Unavoidable, agents need params to call the API. ZK commitments prove response integrity.
- **Silent callback failures**: Hub stores `callbackSuccess` and emits `CallbackExecuted`, but doesn't push-notify. Consumers should monitor this event.

### Writing a consumer

```solidity
// Inherit X402CConsumerBase for callback routing and onlyHub protection.
contract MyConsumer is X402CConsumerBase { ... }

// Keep _onFulfilled() simple. Store data, emit event.
// No external calls here, callback gas is limited.
function _onFulfilled(bytes32 requestId, bytes calldata data) internal override {
    responses[requestId] = data;
    emit Fulfilled(requestId);
}

// Check cost before requesting.
(, uint256 cost) = hub.getEndpointPrice(endpointId);
```

Check `CallbackExecuted` events to confirm your callback ran. Don't store large blobs in the callback, every byte costs gas.

### Running an agent

Set `callbackGasLimit` conservatively (2M gas covers most cases). Match `maxResponseBytes` to your actual response size. Simulate with `estimateGas()` before submitting. Compare gas cost to reimbursement and skip unprofitable requests.

### Verified contracts

All source code is public on Basescan:

- [X402C Hub](https://basescan.org/address/0x46048903457eA7976Aab09Ab379b52753531F08C#code) - request/fulfill/callback
- [X402C Staking](https://basescan.org/address/0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB#code) - stake, slash, rewards
- [X402C Dispute Resolver](https://basescan.org/address/0x27798a59635fb3E3F9e3373BDCAC8a78a43496bE#code) - consumer challenges
- [X402C Price Oracle](https://basescan.org/address/0xdc5c2E4316f516982c9caAC4d28827245e89bf53#code) - ETH/USDC gas pricing
- [X402C Governor](https://basescan.org/address/0x9b9CB431002685aEF9A3f5203A8FF5DB8A8c5781#code) - DAO governance
- [X402C Token](https://basescan.org/address/0x001373f663c235a2112A14e03799813EAa7bC6F1#code) - ERC20Votes governance token
- [X402C KeepAlive](https://basescan.org/address/0x2f5e58C64D5C3F8c0AbCA959d3dB71c134AB0BA6#code) - subscription-based keep-alive

## Pricing

Each agent sets their own endpoint pricing. No fixed protocol fee.

Each endpoint has:
- Base cost: the agent's price for the API call (fractions of a cent)
- Gas reimbursement: covers the on-chain callback TX cost, calculated via a live ETH/USDC oracle

Call `hub.getEndpointPrice(endpointId)` on-chain to get the exact cost before making a request. Returns both non-callback and callback-inclusive price in USDC (6 decimals).

## Available endpoints

| Endpoint ID | Name | Description |
|-------------|------|-------------|
| `0x81a6c35d...` | Alchemy Token Price | Get token prices via Alchemy API |
| `0x15772e06...` | OpenSea Listings | Get NFT collection listings |

Browse all endpoints at [x402c.org/hub](https://x402c.org/hub).

## Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| X402C Hub | [`0x46048903457eA7976Aab09Ab379b52753531F08C`](https://basescan.org/address/0x46048903457eA7976Aab09Ab379b52753531F08C) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| X402C Token | [`0x001373f663c235a2112A14e03799813EAa7bC6F1`](https://basescan.org/address/0x001373f663c235a2112A14e03799813EAa7bC6F1) |
| Demo Consumer | [`0xC707AB8905865f1E97f5CaBf3d2ae798dcb7827a`](https://basescan.org/address/0xC707AB8905865f1E97f5CaBf3d2ae798dcb7827a) |
| KeepAlive | [`0x2f5e58C64D5C3F8c0AbCA959d3dB71c134AB0BA6`](https://basescan.org/address/0x2f5e58C64D5C3F8c0AbCA959d3dB71c134AB0BA6) |

## Files

```
contracts/
  X402CConsumerBase.sol       # Inherit this, handles hub callback routing
  X402CDemoConsumer.sol        # Working example (single-TX pattern)
  X402CKeepAlive.sol           # Subscription-based keep-alive contract
  interfaces/
    IX402CConsumer.sol         # Callback interface for hub consumers
    IX402CKeepAliveConsumer.sol # Callback interface for keep-alive consumers
```

`X402CConsumerBase` is the abstract base for hub consumers. Inherit it and implement `_onFulfilled()`.

`X402CDemoConsumer` is a production example with USDC handling, response storage, and recovery functions.

`X402CKeepAlive` is a standalone contract for periodic automated calls. Contracts register subscriptions, agents race to fulfill them.

## Keep-alive subscriptions

Contracts that need periodic calls (harvest, rebalance, poke) can register subscriptions on the KeepAlive contract. Any agent can fulfill them — first TX wins.

### Write a keep-alive consumer

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IX402CKeepAliveConsumer.sol";

contract MyKeepAliveConsumer is IX402CKeepAliveConsumer {
    address public immutable keepAlive;
    uint256 public lastPoke;

    error OnlyKeepAlive();

    constructor(address _keepAlive) {
        keepAlive = _keepAlive;
    }

    function keepAliveCallback(bytes32 subscriptionId, uint256 cycleNumber) external override {
        if (msg.sender != keepAlive) revert OnlyKeepAlive();
        lastPoke = block.timestamp;
        // your periodic logic here
    }

    /// Optional: return false to skip this cycle. No charge when skipped.
    /// If you don't implement shouldRun(), the subscription is always ready.
    function shouldRun(bytes32) external view override returns (bool) {
        return address(this).balance > 0.001 ether;
    }
}
```

### Conditional keep-alives

Implement `shouldRun()` on your consumer to skip cycles when there's nothing useful to do. The KeepAlive contract checks this before fulfilling — if it returns false, the TX reverts and nobody gets charged.

```solidity
// Only run when the contract has ETH to harvest
function shouldRun(bytes32) external view returns (bool) {
    return address(this).balance > 0.001 ether;
}

// Only run when there's USDC to process
function shouldRun(bytes32) external view returns (bool) {
    return IERC20(usdc).balanceOf(address(this)) > 1_000_000; // > $1
}

// Only run when a specific flag is set
function shouldRun(bytes32) external view returns (bool) {
    return pendingWork > 0;
}
```

`shouldRun()` is optional. If your consumer doesn't implement it, the subscription is always considered ready. Agents call `isReady(subscriptionId)` on the KeepAlive contract to check all conditions (interval, balance, and your `shouldRun()`) in one view call.

### Register a subscription

```solidity
keepAlive.depositUSDC(500_000); // $0.50

keepAlive.createSubscription(
    myConsumer,    // callbackTarget
    200_000,       // callbackGasLimit (also determines gas reimbursement)
    3600,          // intervalSeconds (1 hour)
    50_000,        // feePerCycle ($0.05, range: $0.001 - $1.00)
    0              // maxFulfillments (0 = unlimited)
);
```

Fee must be between $0.001 and $1.00 USDC per cycle.

### Gas reimbursement

Gas reimbursement is computed from the subscription's `callbackGasLimit` using admin-set gas parameters:

```
totalGas = fulfillOverheadGas + callbackGasLimit
gasCostWei = totalGas * weiPerGas
gasReimbursement = oracle.estimateGasCostUsdc(gasCostWei)
```

- `fulfillOverheadGas` — gas used by `fulfill()` excluding the callback (~150k on Base)
- `weiPerGas` — effective wei-per-gas on Base L2 (L2 execution + L1 data posting, ~16 gwei observed)
- The oracle converts ETH cost to USDC at the current market rate

Consumers don't set gas costs. They declare `callbackGasLimit` (how much compute their callback uses), and the protocol computes reimbursement from that. Call `estimateGasReimbursement(callbackGasLimit)` to preview the cost before subscribing.

### Fund recovery

Consumers can withdraw unused USDC at any time:

```solidity
keepAlive.withdrawUSDC(amount);       // pull out unused deposit
keepAlive.cancelSubscription(subId);   // cancel + refund remaining balance
```

### How it works

```
Consumer                    KeepAlive                       Agent
   |                           |                              |
   |-- createSubscription ---->|                              |
   |-- depositUSDC ----------->|                              |
   |                           |                              |
   |                           |<--- fulfill(subId) ----------|  (anyone, race condition)
   |                           |  1. check interval + balance |
   |                           |  2. check shouldRun()        |
   |                           |  3. deduct cost              |
   |                           |  4. pay agent USDC           |
   |                           |  5. try callback { gas cap } |
   |<-- keepAliveCallback -----|     catch { success=false }  |
   |                           |                              |
```

10% markup on fee goes to protocol (buyback → X402C distribution, same as the hub). Agent gets fee + gas reimbursement. Gas reimbursement is computed from the subscription's `callbackGasLimit` and admin-set gas config, converted to USDC via the price oracle.

`isReady(subscriptionId)` checks everything: active, interval, balance, max fulfillments, and `shouldRun()`. Agents poll this to find work.

Cancel anytime with `cancelSubscription()` — remaining USDC balance refunded immediately.

## Building an agent

Agents fulfill requests by watching hub events and submitting API responses.

1. Stake X402C tokens via the [Staking contract](https://basescan.org/address/0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB)
2. Register an endpoint on the hub with your API URL, base cost, and gas config
3. Watch for `RequestCreated` events matching your endpoint ID
4. Fetch the API data using the request parameters
5. Submit via `hub.fulfillRequest(requestId, responseData)`
6. Get paid in USDC automatically on fulfillment

## License

MIT
