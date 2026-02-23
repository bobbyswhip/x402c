/**
 * X402CKeepAlive ABI (per-subscription estimatedGasCostWei)
 * Contract: 0x8b5f10E15f564A7BceaA402068edD94711d68cBF
 */
export const KEEPALIVE_ABI = [
  // ── View functions ──
  {
    type: 'function',
    name: 'getSubscriptionCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'subscriptionIds',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isReady',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getSubscriptionCost',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'fee', type: 'uint256' },
      { name: 'markup', type: 'uint256' },
      { name: 'gasReimbursement', type: 'uint256' },
      { name: 'total', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getSubscription',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'consumer', type: 'address' },
        { name: 'callbackTarget', type: 'address' },
        { name: 'callbackGasLimit', type: 'uint256' },
        { name: 'intervalSeconds', type: 'uint256' },
        { name: 'feePerCycle', type: 'uint256' },
        { name: 'estimatedGasCostWei', type: 'uint256' },
        { name: 'maxFulfillments', type: 'uint256' },
        { name: 'fulfillmentCount', type: 'uint256' },
        { name: 'lastFulfilled', type: 'uint256' },
        { name: 'active', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function',
    name: 'getEthPrice',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'estimateGasReimbursement',
    stateMutability: 'view',
    inputs: [{ name: 'gasCostWei', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getStats',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'volume', type: 'uint256' },
      { name: 'protocolFees', type: 'uint256' },
      { name: 'pendingFees', type: 'uint256' },
      { name: 'subCount', type: 'uint256' },
      { name: 'fulfillments', type: 'uint256' },
    ],
  },

  // ── Write functions ──
  {
    type: 'function',
    name: 'depositUSDC',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawUSDC',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createSubscription',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'callbackTarget', type: 'address' },
      { name: 'callbackGasLimit', type: 'uint256' },
      { name: 'intervalSeconds', type: 'uint256' },
      { name: 'feePerCycle', type: 'uint256' },
      { name: 'estimatedGasCostWei', type: 'uint256' },
      { name: 'maxFulfillments', type: 'uint256' },
    ],
    outputs: [{ name: 'subscriptionId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'cancelSubscription',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'subscriptionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateSubscription',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'subscriptionId', type: 'bytes32' },
      { name: 'callbackGasLimit', type: 'uint256' },
      { name: 'intervalSeconds', type: 'uint256' },
      { name: 'feePerCycle', type: 'uint256' },
      { name: 'estimatedGasCostWei', type: 'uint256' },
      { name: 'maxFulfillments', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fulfill',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'subscriptionId', type: 'bytes32' }],
    outputs: [],
  },

  // ── Events ──
  {
    type: 'event',
    name: 'SubscriptionCreated',
    inputs: [
      { name: 'subscriptionId', type: 'bytes32', indexed: true },
      { name: 'consumer', type: 'address', indexed: true },
      { name: 'callbackTarget', type: 'address', indexed: false },
      { name: 'callbackGasLimit', type: 'uint256', indexed: false },
      { name: 'intervalSeconds', type: 'uint256', indexed: false },
      { name: 'feePerCycle', type: 'uint256', indexed: false },
      { name: 'estimatedGasCostWei', type: 'uint256', indexed: false },
      { name: 'maxFulfillments', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubscriptionFulfilled',
    inputs: [
      { name: 'subscriptionId', type: 'bytes32', indexed: true },
      { name: 'fulfiller', type: 'address', indexed: true },
      { name: 'cycleNumber', type: 'uint256', indexed: false },
      { name: 'agentPayout', type: 'uint256', indexed: false },
      { name: 'protocolFee', type: 'uint256', indexed: false },
      { name: 'callbackSuccess', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SubscriptionCancelled',
    inputs: [
      { name: 'subscriptionId', type: 'bytes32', indexed: true },
      { name: 'consumer', type: 'address', indexed: true },
      { name: 'refunded', type: 'uint256', indexed: false },
    ],
  },
] as const;
