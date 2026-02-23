// Clients
export { createHubClient, type HubClient } from './clients/hub.js';
export { createKeepAliveClient, type KeepAliveClient } from './clients/keepAlive.js';
export { createSwapClient, type SwapClient } from './clients/swap.js';
export { createStakingClient, type StakingClient } from './clients/staking.js';

// Constants
export { ADDRESSES, CHAIN_ID, X402C_POOL_KEY, WASS_IS_TOKEN0 } from './constants.js';

// Types
export type {
  ClientConfig,
  HubRequest,
  EndpointSpec,
  CallbackInfo,
  AgentStats,
  HubStats,
  RequestCreatedEvent,
  Subscription,
  SubscriptionCost,
  SubscriptionCreatedEvent,
  SubscriptionFulfilledEvent,
  StakeInfo,
  WassQuote,
  RouterStats,
  ProfitabilityResult,
  UnwatchFn,
} from './types.js';
export { RequestStatus } from './types.js';

// ABIs (re-exported for power users)
export { HUB_ABI } from './abis/hub.js';
export { KEEPALIVE_ABI } from './abis/keepAlive.js';
export { STAKING_ABI } from './abis/staking.js';
export { ERC20_ABI } from './abis/erc20.js';
export { WASSOTC_ABI } from './abis/wassotc.js';

// Utilities
export { withTxMutex } from './utils/txQueue.js';
export { checkTxProfitability } from './utils/profitability.js';
export { createEventPoller, type PollConfig } from './utils/polling.js';
