// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IX402CConsumer.sol";

/**
 * @title X402CConsumerBase
 * @notice Abstract base contract for x402c API consumers. Similar to Chainlink's VRFConsumerBaseV2.
 *
 * USAGE:
 * 1. Inherit this contract
 * 2. Implement _onFulfilled(requestId, data)
 * 3. Call hub.createRequestWithCallback{value}() to make requests
 * 4. Hub calls x402cFulfilled() → routes to your _onFulfilled()
 */
abstract contract X402CConsumerBase is IX402CConsumer {
    address public immutable hub;

    error OnlyHub();

    modifier onlyHub() {
        if (msg.sender != hub) revert OnlyHub();
        _;
    }

    constructor(address _hub) {
        hub = _hub;
    }

    /**
     * @notice Called by the hub when a request is fulfilled. Routes to _onFulfilled.
     * @dev Only the hub contract can call this (enforced by onlyHub modifier).
     */
    function x402cCallback(bytes32 requestId, bytes calldata responseData) external onlyHub {
        _onFulfilled(requestId, responseData);
    }

    /**
     * @notice Override this in your consumer contract to handle API responses.
     * @param requestId The fulfilled request ID
     * @param responseData The API response (UTF-8 JSON encoded as bytes)
     */
    function _onFulfilled(bytes32 requestId, bytes calldata responseData) internal virtual;
}
