// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IX402CKeepAliveConsumer
 * @notice Interface that contracts implement to receive keep-alive callbacks.
 *
 * Required:
 *   keepAliveCallback() — called by KeepAlive on each fulfillment cycle.
 *
 * Optional:
 *   shouldRun() — if implemented, KeepAlive checks this before fulfilling.
 *   Return false to skip the cycle (no charge, no callback).
 *   If not implemented, the subscription is always considered ready.
 *
 * Example: only run if the contract has ETH to work with:
 *   function shouldRun(bytes32) external view returns (bool) {
 *       return address(this).balance > 0.001 ether;
 *   }
 */
interface IX402CKeepAliveConsumer {
    /**
     * @notice Called by the KeepAlive contract on each fulfillment cycle.
     * @param subscriptionId The subscription that was fulfilled
     * @param cycleNumber Which cycle this is (1-indexed)
     */
    function keepAliveCallback(bytes32 subscriptionId, uint256 cycleNumber) external;

    /**
     * @notice Optional. Return false to skip this cycle. No charge if false.
     *         If not implemented (reverts), the cycle is always considered ready.
     * @param subscriptionId The subscription to check
     * @return ready True if the callback should run this cycle
     */
    function shouldRun(bytes32 subscriptionId) external view returns (bool ready);
}
