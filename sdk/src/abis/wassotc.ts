/**
 * wASSOTC Router ABI (OLD router with swapToToken)
 * Contract: 0xD39bcE42ad5Cf7704e74206aD9551206fa0aD98a
 * Two-hop: ETH -> wASS (OTC hybrid) -> Token (V4)
 */
export const WASSOTC_ABI = [
  {
    inputs: [{ name: 'minWassOut', type: 'uint256' }],
    name: 'swap',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
        name: 'outputPoolKey',
        type: 'tuple',
      },
      { name: 'minWassOut', type: 'uint256' },
      { name: 'minTokenOut', type: 'uint256' },
      { name: 'wassIsToken0', type: 'bool' },
    ],
    name: 'swapToToken',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [{ name: 'ethIn', type: 'uint256' }],
    name: 'quote',
    outputs: [
      { name: 'swapPortion', type: 'uint256' },
      { name: 'otcPortion', type: 'uint256' },
      { name: 'otcAvailable', type: 'uint256' },
      { name: 'currentOtcBps', type: 'uint256' },
      { name: 'currentOtcFeeBps', type: 'uint256' },
      { name: 'hasOtc', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getStats',
    outputs: [
      { name: '_otcBalance', type: 'uint256' },
      { name: '_totalRevenue', type: 'uint256' },
      { name: '_totalSwapVolume', type: 'uint256' },
      { name: '_totalOtcVolume', type: 'uint256' },
      { name: '_totalFeesCollected', type: 'uint256' },
      { name: '_contractEthBalance', type: 'uint256' },
      { name: '_contractWassBalance', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'buyer', type: 'address' },
      { indexed: false, name: 'ethIn', type: 'uint256' },
      { indexed: false, name: 'wassUsed', type: 'uint256' },
      { indexed: false, name: 'outputToken', type: 'address' },
      { indexed: false, name: 'outputAmount', type: 'uint256' },
    ],
    name: 'SwapToToken',
    type: 'event',
  },
] as const;
