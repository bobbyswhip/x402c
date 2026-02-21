// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./X402CConsumerBase.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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

/**
 * @title X402CDemoConsumer
 * @notice Single-TX demo consumer — like Chainlink VRF. Pure USDC, no ETH anywhere.
 *
 * USER FLOW:
 * 1. Approve USDC to this contract (one-time)
 * 2. Call requestData(endpointId, params) — single TX, USDC only
 *    -> Contract pulls USDC from user -> deposits to hub -> creates request with callback
 * 3. Agent fulfills -> hub calls x402cCallback -> result stored on-chain
 * 4. Read responses[requestId] or getLastResponse()
 *
 * RECOVERY:
 * - If a request is cancelled (timeout), USDC gets refunded to this contract's hub balance.
 * - Owner can withdrawERC20() to recover any stranded tokens.
 * - Owner can withdrawETH() to recover any accidentally-sent ETH.
 * - Owner can withdrawHubBalance() to pull USDC out of the hub deposit back to owner.
 */
contract X402CDemoConsumer is X402CConsumerBase {
    IX402CHub public immutable hubContract;
    IERC20 public immutable usdc;
    address public owner;

    // Response storage
    mapping(bytes32 => bytes) public responses;
    mapping(bytes32 => bool) public fulfilled;
    mapping(bytes32 => address) public requesters;
    bytes32 public lastRequestId;
    bytes public lastResponse;
    uint256 public totalCallbacks;
    uint256 public totalRequests;

    error OnlyOwner();
    error InsufficientPayment();

    event DataRequested(bytes32 indexed requestId, bytes32 indexed endpointId, address indexed requester);
    event DataReceived(bytes32 indexed requestId, uint256 responseLength);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _hub, address _usdc) X402CConsumerBase(_hub) {
        hubContract = IX402CHub(_hub);
        usdc = IERC20(_usdc);
        owner = msg.sender;
    }

    /**
     * @notice Request API data in a single TX. Pure USDC — no ETH needed.
     * @dev Caller must have approved USDC to this contract first.
     *      Contract reads price from hub (includes gas reimbursement),
     *      pulls USDC, deposits, creates request with callback.
     * @param endpointId The hub endpoint to query
     * @param params ABI-encoded parameters for the endpoint
     */
    function requestData(
        bytes32 endpointId,
        bytes calldata params
    ) external returns (bytes32 requestId) {
        // 1. Read price from hub (totalWithCallback includes gas reimbursement)
        (, uint256 totalCost) = hubContract.getEndpointPrice(endpointId);
        require(totalCost > 0, "Invalid endpoint");

        // 2. Check if contract already has enough hub balance
        uint256 hubBalance = hubContract.getBalance(address(this));
        if (hubBalance < totalCost) {
            uint256 needed = totalCost - hubBalance;
            // Pull USDC from user
            require(usdc.transferFrom(msg.sender, address(this), needed), "USDC transfer failed");
            // Approve hub to spend
            usdc.approve(hub, needed);
            // Deposit to hub
            hubContract.depositUSDC(needed);
        }

        // 3. Create request with callback (pure USDC — no ETH)
        requestId = hubContract.createRequestWithCallback(
            endpointId,
            params
        );

        requesters[requestId] = msg.sender;
        lastRequestId = requestId;
        totalRequests++;

        emit DataRequested(requestId, endpointId, msg.sender);
    }

    /**
     * @dev Called by hub via X402CConsumerBase when request is fulfilled.
     */
    function _onFulfilled(bytes32 requestId, bytes calldata responseData) internal override {
        responses[requestId] = responseData;
        fulfilled[requestId] = true;
        lastResponse = responseData;
        totalCallbacks++;
        emit DataReceived(requestId, responseData.length);
    }

    /**
     * @notice Check the total cost for a callback request.
     */
    function checkPrice(bytes32 endpointId) external view returns (uint256 total, uint256 totalWithCallback) {
        return hubContract.getEndpointPrice(endpointId);
    }

    /**
     * @notice Read the response for a request as a string.
     */
    function getResponse(bytes32 requestId) external view returns (string memory) {
        return string(responses[requestId]);
    }

    /**
     * @notice Read the last response as a string.
     */
    function getLastResponse() external view returns (string memory) {
        return string(lastResponse);
    }

    // ── Recovery Functions ────────────────────────────────────────────

    /**
     * @notice Withdraw any ERC20 tokens stranded in this contract.
     *         Used to recover USDC refunded from cancelled requests.
     */
    function withdrawERC20(address token, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(msg.sender, amount), "Transfer failed");
    }

    /**
     * @notice Withdraw any ETH accidentally sent to this contract.
     */
    function withdrawETH() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH");
        (bool ok,) = msg.sender.call{value: bal}("");
        require(ok, "ETH transfer failed");
    }

    /**
     * @notice Transfer ownership to a new address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    // Accept ETH transfers (in case someone sends ETH accidentally)
    receive() external payable {}
}
