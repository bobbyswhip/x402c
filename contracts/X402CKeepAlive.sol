// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IX402CKeepAliveConsumer.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IX402CBuybackModule {
    function receiveUSDC(uint256 amount) external;
}

interface IX402CPriceOracle {
    function getEthPriceUsdc() external view returns (uint256);
    function estimateGasCostUsdc(uint256 gasCostWei) external view returns (uint256);
}

/**
 * @title X402CKeepAlive
 * @notice Subscription-based keep-alive system. Contracts register subscriptions,
 *         any agent can fulfill them on a race-condition basis (first TX wins).
 *
 * Same fee structure as the X402C Hub:
 *   markup = (baseCost * 10%) capped at $1
 *   gasReimbursement = oracle.estimateGasCostUsdc(estimatedGasCostWei)
 *   Agent gets: baseCost + gasReimbursement
 *   Protocol gets: markup (accumulated, flushable to buyback)
 *
 * No agent registration required. Any address can call fulfill().
 */
contract X402CKeepAlive {

    // ========== STATE ==========

    IERC20 public immutable usdc;
    address public owner;

    IX402CPriceOracle public priceOracle;
    IX402CBuybackModule public buybackModule;

    // Consumer USDC deposits
    mapping(address => uint256) public balances;

    // Subscriptions
    mapping(bytes32 => Subscription) public subscriptions;
    bytes32[] public subscriptionIds;

    // Protocol fee accumulator
    uint256 public protocolFeesAccumulator;
    uint256 public totalProtocolFeesUSDC;
    uint256 public totalVolumeUSDC;
    uint256 public totalFulfillments;

    // Reentrancy guard
    bool private _locked;

    // ========== CONSTANTS ==========

    uint256 public constant MARKUP_BPS = 1000;          // 10%
    uint256 public constant MAX_MARKUP = 1_000_000;     // $1 cap (6 decimals)
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ========== TYPES ==========

    struct Subscription {
        address consumer;            // who registered and pays
        address callbackTarget;      // contract to call back
        uint256 callbackGasLimit;    // gas cap per callback
        uint256 intervalSeconds;     // min time between cycles
        uint256 baseCostUnits;       // USDC per cycle (6 decimals)
        uint256 estimatedGasCostWei; // for oracle gas calc
        uint256 maxFulfillments;     // 0 = unlimited
        uint256 fulfillmentCount;    // how many times fulfilled
        uint256 lastFulfilled;       // timestamp of last fulfill
        bool active;                 // can be fulfilled
    }

    struct CallbackResult {
        bool executed;
        bool success;
    }

    // ========== EVENTS ==========

    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed consumer,
        address callbackTarget,
        uint256 intervalSeconds,
        uint256 baseCostUnits,
        uint256 estimatedGasCostWei,
        uint256 maxFulfillments
    );
    event SubscriptionCancelled(bytes32 indexed subscriptionId, address indexed consumer, uint256 refunded);
    event SubscriptionUpdated(bytes32 indexed subscriptionId);
    event SubscriptionFulfilled(
        bytes32 indexed subscriptionId,
        address indexed fulfiller,
        uint256 cycleNumber,
        uint256 agentPayout,
        bool callbackSuccess
    );

    event USDCDeposited(address indexed depositor, uint256 amount);
    event USDCWithdrawn(address indexed depositor, uint256 amount);
    event ProtocolFeesFlushed(uint256 amount);
    event ProtocolFeesWithdrawn(address indexed admin, uint256 amount);
    event BuybackModuleSet(address indexed module);
    event PriceOracleUpdated(address indexed oracle);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event FundsRecovered(address indexed admin, address token, uint256 amount);

    // ========== ERRORS ==========

    error NotOwner();
    error InsufficientBalance();
    error SubscriptionNotFound();
    error SubscriptionInactive();
    error IntervalNotReached();
    error MaxFulfillmentsReached();
    error TransferFailed();
    error ZeroAmount();
    error ZeroAddress();
    error ZeroInterval();
    error Reentrancy();
    error OracleNotSet();
    error BuybackModuleNotSet();
    error NoFeesToWithdraw();
    error NotSubscriptionOwner();

    // ========== MODIFIERS ==========

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ========== CONSTRUCTOR ==========

    constructor(address _usdc, address _priceOracle) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
        priceOracle = IX402CPriceOracle(_priceOracle);
    }

    // ========== CONSUMER: DEPOSIT / WITHDRAW ==========

    function depositUSDC(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        bool ok = usdc.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        balances[msg.sender] += amount;
        emit USDCDeposited(msg.sender, amount);
    }

    function withdrawUSDC(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();
        balances[msg.sender] -= amount;
        bool ok = usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit USDCWithdrawn(msg.sender, amount);
    }

    // ========== SUBSCRIPTION MANAGEMENT ==========

    function createSubscription(
        address callbackTarget,
        uint256 callbackGasLimit,
        uint256 intervalSeconds,
        uint256 baseCostUnits,
        uint256 estimatedGasCostWei,
        uint256 maxFulfillments
    ) external returns (bytes32 subscriptionId) {
        if (callbackTarget == address(0)) revert ZeroAddress();
        if (intervalSeconds == 0) revert ZeroInterval();

        subscriptionId = keccak256(abi.encodePacked(
            msg.sender,
            callbackTarget,
            block.timestamp,
            block.prevrandao,
            subscriptionIds.length
        ));

        subscriptions[subscriptionId] = Subscription({
            consumer: msg.sender,
            callbackTarget: callbackTarget,
            callbackGasLimit: callbackGasLimit,
            intervalSeconds: intervalSeconds,
            baseCostUnits: baseCostUnits,
            estimatedGasCostWei: estimatedGasCostWei,
            maxFulfillments: maxFulfillments,
            fulfillmentCount: 0,
            lastFulfilled: 0,
            active: true
        });

        subscriptionIds.push(subscriptionId);

        emit SubscriptionCreated(
            subscriptionId,
            msg.sender,
            callbackTarget,
            intervalSeconds,
            baseCostUnits,
            estimatedGasCostWei,
            maxFulfillments
        );
    }

    function cancelSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.consumer == address(0)) revert SubscriptionNotFound();
        if (sub.consumer != msg.sender) revert NotSubscriptionOwner();

        sub.active = false;

        // Refund remaining balance
        uint256 refund = balances[msg.sender];
        if (refund > 0) {
            balances[msg.sender] = 0;
            bool ok = usdc.transfer(msg.sender, refund);
            if (!ok) revert TransferFailed();
        }

        emit SubscriptionCancelled(subscriptionId, msg.sender, refund);
    }

    function updateSubscription(
        bytes32 subscriptionId,
        uint256 callbackGasLimit,
        uint256 intervalSeconds,
        uint256 baseCostUnits,
        uint256 estimatedGasCostWei,
        uint256 maxFulfillments
    ) external {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.consumer == address(0)) revert SubscriptionNotFound();
        if (sub.consumer != msg.sender) revert NotSubscriptionOwner();
        if (intervalSeconds == 0) revert ZeroInterval();

        sub.callbackGasLimit = callbackGasLimit;
        sub.intervalSeconds = intervalSeconds;
        sub.baseCostUnits = baseCostUnits;
        sub.estimatedGasCostWei = estimatedGasCostWei;
        sub.maxFulfillments = maxFulfillments;

        emit SubscriptionUpdated(subscriptionId);
    }

    // ========== FULFILLMENT (RACE CONDITION — ANYONE CAN CALL) ==========

    /**
     * @notice Fulfill a keep-alive subscription. Anyone can call. First TX wins.
     * @dev Checks interval timing, deducts cost from consumer balance,
     *      pays caller, accumulates protocol fee, fires callback.
     */
    function fulfill(bytes32 subscriptionId) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.consumer == address(0)) revert SubscriptionNotFound();
        if (!sub.active) revert SubscriptionInactive();

        // Check interval
        if (sub.lastFulfilled != 0 && block.timestamp < sub.lastFulfilled + sub.intervalSeconds) {
            revert IntervalNotReached();
        }

        // Check max fulfillments
        if (sub.maxFulfillments > 0 && sub.fulfillmentCount >= sub.maxFulfillments) {
            revert MaxFulfillmentsReached();
        }

        // Compute cost
        uint256 baseCost = sub.baseCostUnits;
        uint256 markup = (baseCost * MARKUP_BPS) / BPS_DENOMINATOR;
        if (markup > MAX_MARKUP) markup = MAX_MARKUP;
        uint256 gasReimbursement = _computeGasReimbursement(sub.estimatedGasCostWei);
        uint256 totalCost = baseCost + markup + gasReimbursement;

        // Deduct from consumer
        if (balances[sub.consumer] < totalCost) revert InsufficientBalance();
        balances[sub.consumer] -= totalCost;

        // Update state before external calls
        sub.fulfillmentCount++;
        sub.lastFulfilled = block.timestamp;
        totalFulfillments++;

        // Auto-deactivate if max reached
        if (sub.maxFulfillments > 0 && sub.fulfillmentCount >= sub.maxFulfillments) {
            sub.active = false;
        }

        // Pay agent: baseCost + gasReimbursement
        uint256 agentPayout = baseCost + gasReimbursement;
        if (agentPayout > 0) {
            bool ok = usdc.transfer(msg.sender, agentPayout);
            if (!ok) revert TransferFailed();
        }

        // Accumulate protocol fee
        if (markup > 0) {
            protocolFeesAccumulator += markup;
            totalProtocolFeesUSDC += markup;
        }

        totalVolumeUSDC += totalCost;

        // Execute callback (try/catch, gas-limited)
        bool callbackSuccess = _executeCallback(subscriptionId, sub);

        emit SubscriptionFulfilled(
            subscriptionId,
            msg.sender,
            sub.fulfillmentCount,
            agentPayout,
            callbackSuccess
        );
    }

    // ========== PRICE ORACLE ==========

    function setPriceOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert ZeroAddress();
        priceOracle = IX402CPriceOracle(_oracle);
        emit PriceOracleUpdated(_oracle);
    }

    function _computeGasReimbursement(uint256 estimatedGasCostWei) internal view returns (uint256) {
        if (address(priceOracle) == address(0)) revert OracleNotSet();
        return priceOracle.estimateGasCostUsdc(estimatedGasCostWei);
    }

    // ========== BUYBACK ==========

    function setBuybackModule(address module) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        buybackModule = IX402CBuybackModule(module);
        emit BuybackModuleSet(module);
    }

    function flushProtocolFees() external onlyOwner {
        if (address(buybackModule) == address(0)) revert BuybackModuleNotSet();
        uint256 amount = protocolFeesAccumulator;
        if (amount == 0) revert NoFeesToWithdraw();

        protocolFeesAccumulator = 0;

        usdc.approve(address(buybackModule), amount);
        buybackModule.receiveUSDC(amount);

        emit ProtocolFeesFlushed(amount);
    }

    function withdrawProtocolFees() external onlyOwner {
        uint256 amount = protocolFeesAccumulator;
        if (amount == 0) revert NoFeesToWithdraw();
        protocolFeesAccumulator = 0;
        bool ok = usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit ProtocolFeesWithdrawn(msg.sender, amount);
    }

    // ========== ADMIN ==========

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function recoverFunds(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            bool ok = IERC20(token).transfer(msg.sender, amount);
            if (!ok) revert TransferFailed();
        }
        emit FundsRecovered(msg.sender, token, amount);
    }

    // ========== VIEW FUNCTIONS ==========

    function getSubscriptionCount() external view returns (uint256) {
        return subscriptionIds.length;
    }

    function getSubscription(bytes32 id) external view returns (Subscription memory) {
        return subscriptions[id];
    }

    function getSubscriptionCost(bytes32 id) external view returns (
        uint256 baseCost,
        uint256 markup,
        uint256 gasReimbursement,
        uint256 total
    ) {
        Subscription storage sub = subscriptions[id];
        baseCost = sub.baseCostUnits;
        markup = (baseCost * MARKUP_BPS) / BPS_DENOMINATOR;
        if (markup > MAX_MARKUP) markup = MAX_MARKUP;
        gasReimbursement = _computeGasReimbursement(sub.estimatedGasCostWei);
        total = baseCost + markup + gasReimbursement;
    }

    function isReady(bytes32 id) external view returns (bool) {
        Subscription storage sub = subscriptions[id];
        if (!sub.active) return false;
        if (sub.maxFulfillments > 0 && sub.fulfillmentCount >= sub.maxFulfillments) return false;
        if (sub.lastFulfilled != 0 && block.timestamp < sub.lastFulfilled + sub.intervalSeconds) return false;

        // Check if consumer has enough balance
        uint256 baseCost = sub.baseCostUnits;
        uint256 markup = (baseCost * MARKUP_BPS) / BPS_DENOMINATOR;
        if (markup > MAX_MARKUP) markup = MAX_MARKUP;
        uint256 gasReimbursement = _computeGasReimbursement(sub.estimatedGasCostWei);
        uint256 totalCost = baseCost + markup + gasReimbursement;

        return balances[sub.consumer] >= totalCost;
    }

    function getBalance(address account) external view returns (uint256) {
        return balances[account];
    }

    function getEthPrice() external view returns (uint256) {
        if (address(priceOracle) == address(0)) revert OracleNotSet();
        return priceOracle.getEthPriceUsdc();
    }

    function getStats() external view returns (
        uint256 volume,
        uint256 protocolFees,
        uint256 pendingFees,
        uint256 subCount,
        uint256 fulfillments
    ) {
        return (
            totalVolumeUSDC,
            totalProtocolFeesUSDC,
            protocolFeesAccumulator,
            subscriptionIds.length,
            totalFulfillments
        );
    }

    // ========== INTERNAL ==========

    function _executeCallback(bytes32 subscriptionId, Subscription storage sub) internal returns (bool) {
        if (sub.callbackGasLimit == 0) return true;

        try IX402CKeepAliveConsumer(sub.callbackTarget).keepAliveCallback{gas: sub.callbackGasLimit}(
            subscriptionId,
            sub.fulfillmentCount
        ) {
            return true;
        } catch {
            return false;
        }
    }
}
