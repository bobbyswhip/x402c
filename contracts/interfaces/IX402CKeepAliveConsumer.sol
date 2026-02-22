// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IX402CKeepAliveConsumer
 * @notice Interface that contracts implement to receive keep-alive callbacks.
 *         Consumer contracts inherit this and implement keepAliveCallback().
 */
interface IX402CKeepAliveConsumer {
    /**
     * @notice Called by the KeepAlive contract on each fulfillment cycle.
     * @param subscriptionId The subscription that was fulfilled
     * @param cycleNumber Which cycle this is (1-indexed)
     */
    function keepAliveCallback(bytes32 subscriptionId, uint256 cycleNumber) external;
}
