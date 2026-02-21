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
