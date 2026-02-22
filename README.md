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

## Security

We get asked about callback safety a lot, so this section walks through the actual attack surface and what the contracts do about it.

### How fulfillment actually works

The ordering inside `fulfillRequest()` matters. Here's the sequence:

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

State gets marked `FULFILLED` before any external call happens. The agent gets paid before the callback runs. If the callback reverts, the hub catches it and records `success = false`, but the fulfillment still stands.

### Can a malicious consumer steal from agents via callback?

No. The call chain looks like this:

```
Agent wallet -> fulfillRequest() -> Hub -> x402cCallback() -> Consumer contract
                 msg.sender           msg.sender
                 = agent              = hub (not agent)
```

Inside the callback, `msg.sender` is the hub contract. A malicious callback trying `USDC.transferFrom(tx.origin, attacker, ...)` would fail because the agent wallet never approved the consumer contract for any token. The agent has no relationship with the consumer at all.

The callback also runs with a hard gas cap (`endpoint.callbackGasLimit`, set by the agent). An infinite loop or storage bomb burns through that budget and stops. The agent already got paid before the callback started, so they lose nothing.

A reentrancy lock (`nonReentrant`) on `fulfillRequest()` blocks the callback from calling back into the hub to double-fulfill or manipulate state.

### Payment ordering

The hub follows checks-effects-interactions everywhere. The short version:

When creating a request, the consumer's balance is deducted *before* the request struct is written. If anything fails after that, the deduction already happened.

When fulfilling, the request status flips to `FULFILLED` before any USDC transfer or callback. A revert in the transfer or callback can't undo the status change.

When cancelling, the status flips to `CANCELLED` first, then the refund is credited internally, then the canceller's share transfers out.

### What agents should worry about (and shouldn't)

Could a consumer deploy a callback that wastes gas on purpose? Sure, but with the gas cap at 2M that burns ~$0.06 on Base. The agent is already paid by that point. It's a nuisance, not a theft vector.

What about a callback that sneaks in an `approve()` call to drain the agent? Doesn't work. `msg.sender` inside the callback is the hub, not the agent wallet. The consumer can only approve tokens on behalf of itself. The agent never approved anything to the consumer contract.

Double fulfillment isn't possible either. The hub checks `status == PENDING` before accepting a response. Second call reverts.

The reference agent implementation simulates every fulfillment with `estimateGas()` before submitting and compares the gas cost to the reimbursement. If it's a losing trade, the agent just skips it.

Slashing can only come from three addresses: the hub contract, the governance timelock, and the dispute resolver. The slash is capped at whatever the agent has staked.

### What consumers should worry about

If an agent doesn't respond, requests time out after 5 minutes. Anyone can cancel a timed-out request. The consumer gets 100% of gas reimbursement back plus 90% of the API cost.

If an agent sends bad data, consumers can open a dispute by staking 100 X402C as a bond. A resolver reviews within 3 days. Upheld means the agent gets slashed 50% and the bond comes back. Rejected means the bond splits 50/50 between staker rewards and liquidity.

You can check pricing before you commit. `getEndpointPrice()` returns the exact USDC cost, and you can compare across agents.

The hub also rejects any response larger than the endpoint's `maxResponseBytes` setting, so an agent can't submit a huge payload that blows through your callback gas budget.

### Who can do what

Here's what each role can and can't do:

| Role | Allowed | Not allowed |
|------|---------|-------------|
| Owner | Add/remove admins, emergency token recovery | Fulfill requests, touch consumer balances |
| Admin | Register agents, configure protocol settings | Move consumer deposits, override outcomes |
| Agent | Register endpoints, fulfill own requests, set own pricing | Fulfill other agents' requests, access protocol fees |
| Consumer | Deposit USDC, create requests, file disputes | Withdraw other consumers' funds |
| Governance (timelock) | Execute proposals after 24h delay | Skip the delay, change contracts directly |

Contract ownership has been transferred to a governance timelock with a 24-hour delay. Admin wallet changes, fee configuration, and module swaps all go through the timelock.

### Staking and slashing

Agents stake X402C tokens as collateral. If they submit bad data or lose a dispute, they get slashed.

Slashing only happens for bad data (failed sanity check) or upheld disputes. Timeouts don't trigger slashes, they just dock reputation. Slash proceeds split 50/50 between the staker reward pool and the V4 liquidity hook, so nobody profits directly from someone else getting slashed.

There's a cooldown on unstaking. An agent can't see a dispute coming and yank their stake before it lands.

### Disputes

1. Consumer stakes 100 X402C bond, opens dispute with evidence
2. Resolver reviews within 3 days
3. Upheld: agent slashed 50%, bond returned to consumer
4. Rejected: bond splits 50/50 (staker rewards + liquidity)
5. If nobody resolves it within 10 days, the consumer reclaims their bond automatically

The bond stops spam. The grace period stops resolvers from sitting on disputes indefinitely.

### Gas pricing

Gas reimbursement comes from a Uniswap V2 oracle that reads the current ETH/USDC rate via `getAmountsOut`. The admin sets an estimated gas cost in wei per endpoint based on observed callback usage, and the oracle converts that to USDC.

The gas cost is snapshotted when the request is created. If ETH price moves between request creation and fulfillment, neither the agent nor the consumer is affected, they both locked in the price at creation time.

The oracle is swappable via `setPriceOracle()`. If V3 TWAP or Chainlink makes more sense later, the hub doesn't need to be redeployed.

### What we know isn't perfect

The oracle reads Uniswap V2 spot price, not a TWAP. A flash loan could manipulate ETH/USDC for one block, but gas reimbursement per request is $0.01-0.02, so there's nothing worth stealing. The oracle is swappable via `setPriceOracle()` if we move to V3 TWAP or Chainlink later.

The owner wallet can recover stuck tokens and add admins. That wallet is behind a 24-hour governance timelock, so changes are visible on-chain a full day before they execute.

Agents see request parameters. That's unavoidable because agents need them to call the API. ZK commitments on the response prove data integrity after the fact.

Callback failures don't push-notify anyone. The hub stores `callbackSuccess = false` and emits `CallbackExecuted`, but consumers need to watch for it themselves.

### Writing your consumer

```solidity
// Inherit X402CConsumerBase. It handles callback routing and the onlyHub check.
contract MyConsumer is X402CConsumerBase { ... }

// Keep _onFulfilled() simple. Store data, emit an event, move on.
// Don't make external calls here. The callback gas budget is limited.
function _onFulfilled(bytes32 requestId, bytes calldata data) internal override {
    responses[requestId] = data;
    emit Fulfilled(requestId);
}

// Check cost before requesting.
(, uint256 cost) = hub.getEndpointPrice(endpointId);
```

Don't assume the callback always succeeds. Check the `CallbackExecuted` event or read `callbackSuccess` on-chain. Don't store large response blobs in the callback, every byte costs gas.

### Running an agent

Set `callbackGasLimit` to something reasonable. 2M gas handles most cases. If your API returns 200 bytes, don't set `maxResponseBytes` to 10KB.

Simulate fulfillment with `estimateGas()` before submitting. Compare the gas cost to the reimbursement. If it's a losing trade, skip it.

Your stake is your collateral. Higher stake means better reputation, but it also means more at risk if you get slashed.

### All contracts are verified

Source code is public on Basescan:

- [X402C Hub](https://basescan.org/address/0x46048903457eA7976Aab09Ab379b52753531F08C#code) - request/fulfill/callback logic
- [X402C Staking](https://basescan.org/address/0xd57905dc8eE86343Fd54Ba4Bb8cF68785F6326CB#code) - stake, slash, rewards
- [X402C Dispute Resolver](https://basescan.org/address/0x27798a59635fb3E3F9e3373BDCAC8a78a43496bE#code) - consumer challenges
- [X402C Price Oracle](https://basescan.org/address/0xdc5c2E4316f516982c9caAC4d28827245e89bf53#code) - ETH/USDC gas pricing
- [X402C Governor](https://basescan.org/address/0x9b9CB431002685aEF9A3f5203A8FF5DB8A8c5781#code) - DAO governance
- [X402C Token](https://basescan.org/address/0x001373f663c235a2112A14e03799813EAa7bC6F1#code) - ERC20Votes governance token

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
