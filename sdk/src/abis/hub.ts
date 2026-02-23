/**
 * X402CHubContract ABI (oracle-based gas pricing)
 * Contract: 0x7C6Fb07837776136dF87Df762fD03dA4b36ba2E2
 */
export const HUB_ABI = [
  // ── Events ──
  {
    type: 'event',
    name: 'RequestCreated',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'endpointId', type: 'bytes32', indexed: true },
      { name: 'requester', type: 'address', indexed: true },
      { name: 'endpointOwner', type: 'address', indexed: false },
      { name: 'costUnits', type: 'uint256', indexed: false },
      { name: 'gasReimbursement', type: 'uint256', indexed: false },
      { name: 'createdAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RequestFulfilled',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'sessionId', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CallbackExecuted',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'success', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RequestCancelled',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'PriceOracleUpdated',
    inputs: [
      { name: 'oracle', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'EndpointUpdated',
    inputs: [
      { name: 'endpointId', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'EndpointGasConfigUpdated',
    inputs: [
      { name: 'endpointId', type: 'bytes32', indexed: true },
      { name: 'estimatedGasCostWei', type: 'uint256', indexed: false },
      { name: 'callbackGasLimit', type: 'uint256', indexed: false },
    ],
  },

  // ── Read functions ──
  {
    type: 'function',
    name: 'getEndpointCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'endpointIds',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getEndpoint',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'url', type: 'string' },
      { name: 'inputFormat', type: 'string' },
      { name: 'outputFormat', type: 'string' },
      { name: 'baseCostUnits', type: 'uint256' },
      { name: 'maxResponseBytes_', type: 'uint256' },
      { name: 'callbackGasLimit', type: 'uint256' },
      { name: 'estimatedGasCostWei_', type: 'uint256' },
      { name: 'endpointOwner', type: 'address' },
      { name: 'active', type: 'bool' },
      { name: 'registeredAt', type: 'uint256' },
    ],
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
    name: 'getEndpointPrice',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'total', type: 'uint256' },
      { name: 'totalWithCallback', type: 'uint256' },
    ],
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
    name: 'protocolFeesAccumulator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRequest',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'endpointId', type: 'bytes32' },
        { name: 'requester', type: 'address' },
        { name: 'totalCostUnits', type: 'uint256' },
        { name: 'baseCostUnits', type: 'uint256' },
        { name: 'markupUnits', type: 'uint256' },
        { name: 'gasReimbursementUnits', type: 'uint256' },
        { name: 'createdAt', type: 'uint256' },
        { name: 'status', type: 'uint8' },
        { name: 'responseData', type: 'bytes' },
        { name: 'sessionId', type: 'bytes32' },
        { name: 'fulfilledBy', type: 'address' },
        { name: 'params', type: 'bytes' },
        { name: 'hasCallback', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function',
    name: 'getCallback',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'gasLimit', type: 'uint256' },
        { name: 'executed', type: 'bool' },
        { name: 'success', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function',
    name: 'getAgentStats',
    stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [
      { name: 'earnings', type: 'uint256' },
      { name: 'fulfillCount', type: 'uint256' },
      { name: 'isRegistered', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getHubStats',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'volume', type: 'uint256' },
      { name: 'protocolFees', type: 'uint256' },
      { name: 'pendingFees', type: 'uint256' },
      { name: 'endpointCount', type: 'uint256' },
      { name: 'requestsServed', type: 'uint256' },
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
    name: 'createRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'endpointId', type: 'bytes32' },
      { name: 'params', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'createRequestWithCallback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'endpointId', type: 'bytes32' },
      { name: 'params', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'fulfillRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'bytes32' },
      { name: 'responseData', type: 'bytes' },
      { name: 'sessionId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelRequest',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
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
    name: 'deactivateEndpoint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reactivateEndpoint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'flushProtocolFeesToBuyback',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;
