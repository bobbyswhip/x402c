// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IX402CConsumer
 * @notice Interface that consumer contracts must implement to receive callbacks.
 *         Similar to Chainlink's VRFConsumerBaseV2 pattern.
 */
interface IX402CConsumer {
    /**
     * @notice Called by the hub when an API request is fulfilled.
     * @param requestId The request that was fulfilled
     * @param responseData The API response data (UTF-8 JSON encoded as bytes)
     */
    function x402cCallback(bytes32 requestId, bytes calldata responseData) external;
}
