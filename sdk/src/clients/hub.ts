/**
 * Hub Client
 *
 * Interact with the X402CHubContract — create requests, fulfill them,
 * watch for events, and check profitability.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { HUB_ABI } from '../abis/hub.js';
import { ERC20_ABI } from '../abis/erc20.js';
import { ADDRESSES } from '../constants.js';
import type {
  ClientConfig,
  EndpointSpec,
  HubRequest,
  CallbackInfo,
  AgentStats,
  HubStats,
  RequestCreatedEvent,
  ProfitabilityResult,
  UnwatchFn,
} from '../types.js';
import { withTxMutex } from '../utils/txQueue.js';
import { checkTxProfitability } from '../utils/profitability.js';
import { createEventPoller } from '../utils/polling.js';

export function createHubClient(config: ClientConfig) {
  const { publicClient, walletClient } = config;
  const hubAddress = ADDRESSES.HUB as Address;
  const usdcAddress = ADDRESSES.USDC as Address;

  function requireWallet() {
    if (!walletClient) throw new Error('walletClient required for write operations');
    return walletClient;
  }

  // ── Read Functions ──────────────────────────────────────────────────────

  async function getEndpointCount(): Promise<bigint> {
    return publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEndpointCount',
    }) as Promise<bigint>;
  }

  async function getEndpoint(id: Hex): Promise<EndpointSpec> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEndpoint',
      args: [id],
    }) as any;

    return {
      id,
      url: result[0] as string,
      inputFormat: result[1] as string,
      outputFormat: result[2] as string,
      baseCostUnits: result[3] as bigint,
      maxResponseBytes: result[4] as bigint,
      callbackGasLimit: result[5] as bigint,
      estimatedGasCostWei: result[6] as bigint,
      owner: result[7] as Address,
      active: result[8] as boolean,
      registeredAt: result[9] as bigint,
    };
  }

  async function getEndpoints(): Promise<EndpointSpec[]> {
    const count = await getEndpointCount();
    const ids: Hex[] = [];
    for (let i = 0n; i < count; i++) {
      const id = await publicClient.readContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'endpointIds',
        args: [i],
      }) as Hex;
      ids.push(id);
    }
    return Promise.all(ids.map(getEndpoint));
  }

  async function getEndpointPrice(id: Hex): Promise<{ total: bigint; totalWithCallback: bigint }> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEndpointPrice',
      args: [id],
    }) as any;
    return { total: result[0] as bigint, totalWithCallback: result[1] as bigint };
  }

  async function getRequest(requestId: Hex): Promise<HubRequest> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getRequest',
      args: [requestId],
    }) as any;
    return {
      endpointId: result.endpointId,
      requester: result.requester,
      totalCostUnits: result.totalCostUnits,
      baseCostUnits: result.baseCostUnits,
      markupUnits: result.markupUnits,
      gasReimbursementUnits: result.gasReimbursementUnits,
      createdAt: result.createdAt,
      status: Number(result.status),
      responseData: result.responseData,
      sessionId: result.sessionId,
      fulfilledBy: result.fulfilledBy,
      params: result.params,
      hasCallback: result.hasCallback,
    };
  }

  async function getCallback(requestId: Hex): Promise<CallbackInfo> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getCallback',
      args: [requestId],
    }) as any;
    return {
      gasLimit: result.gasLimit,
      executed: result.executed,
      success: result.success,
    };
  }

  async function getBalance(account: Address): Promise<bigint> {
    return publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getBalance',
      args: [account],
    }) as Promise<bigint>;
  }

  async function getAgentStats(agent: Address): Promise<AgentStats> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getAgentStats',
      args: [agent],
    }) as any;
    return {
      earnings: result[0] as bigint,
      fulfillCount: result[1] as bigint,
      isRegistered: result[2] as boolean,
    };
  }

  async function getHubStats(): Promise<HubStats> {
    const result = await publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getHubStats',
    }) as any;
    return {
      volume: result[0] as bigint,
      protocolFees: result[1] as bigint,
      pendingFees: result[2] as bigint,
      endpointCount: result[3] as bigint,
      requestsServed: result[4] as bigint,
    };
  }

  async function getEthPrice(): Promise<bigint> {
    return publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'getEthPrice',
    }) as Promise<bigint>;
  }

  async function estimateGasReimbursement(gasCostWei: bigint): Promise<bigint> {
    return publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'estimateGasReimbursement',
      args: [gasCostWei],
    }) as Promise<bigint>;
  }

  async function getProtocolFees(): Promise<bigint> {
    return publicClient.readContract({
      address: hubAddress,
      abi: HUB_ABI,
      functionName: 'protocolFeesAccumulator',
    }) as Promise<bigint>;
  }

  // ── Event Watching ──────────────────────────────────────────────────────

  function watchRequests(
    callback: (event: RequestCreatedEvent) => void,
    opts?: { pollIntervalMs?: number },
  ): UnwatchFn {
    const requestCreatedEvent = HUB_ABI.find(
      (e) => e.type === 'event' && e.name === 'RequestCreated',
    )!;

    return createEventPoller({
      publicClient,
      address: hubAddress,
      events: [requestCreatedEvent],
      pollIntervalMs: opts?.pollIntervalMs ?? 2000,
      onLogs: (_name, args) => {
        callback({
          requestId: args.requestId,
          endpointId: args.endpointId,
          requester: args.requester,
          endpointOwner: args.endpointOwner,
          costUnits: args.costUnits,
          gasReimbursement: args.gasReimbursement,
          createdAt: args.createdAt,
        });
      },
    });
  }

  function watchConfigEvents(
    callback: (eventName: string) => void,
  ): UnwatchFn {
    const configEvents = HUB_ABI.filter(
      (e) => e.type === 'event' && (
        e.name === 'PriceOracleUpdated' ||
        e.name === 'EndpointUpdated' ||
        e.name === 'EndpointGasConfigUpdated'
      ),
    );

    return createEventPoller({
      publicClient,
      address: hubAddress,
      events: configEvents,
      pollIntervalMs: 10000,
      onLogs: (eventName) => {
        callback(eventName);
      },
    });
  }

  // ── Write Functions ─────────────────────────────────────────────────────

  async function depositUSDC(amount: bigint): Promise<Hex> {
    const wc = requireWallet();
    const account = wc.account!;

    // Check allowance and approve if needed
    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, hubAddress],
    }) as bigint;

    if (allowance < amount) {
      await withTxMutex(() =>
        wc.writeContract({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [hubAddress, amount],
          account,
          chain: wc.chain,
        }),
      );
    }

    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'depositUSDC',
        args: [amount],
        account,
        chain: wc.chain,
      }),
    );
  }

  async function createRequest(endpointId: Hex, params: Hex): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'createRequest',
        args: [endpointId, params],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function createRequestWithCallback(endpointId: Hex, params: Hex): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'createRequestWithCallback',
        args: [endpointId, params],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function checkProfitability(
    requestId: Hex,
    responseData: string | Hex,
    sessionId: Hex,
  ): Promise<ProfitabilityResult> {
    const wc = requireWallet();
    const request = await getRequest(requestId);
    const reimbursement = request.gasReimbursementUnits + request.baseCostUnits;

    const responseHex: Hex = typeof responseData === 'string' && !responseData.startsWith('0x')
      ? (`0x${Buffer.from(responseData).toString('hex')}` as Hex)
      : (responseData as Hex);

    return checkTxProfitability({
      publicClient,
      contractAddress: hubAddress,
      abi: HUB_ABI,
      functionName: 'fulfillRequest',
      args: [requestId, responseHex, sessionId],
      account: wc.account!.address,
      reimbursementUsdc: reimbursement,
      getEthPrice,
    });
  }

  async function fulfillRequest(
    requestId: Hex,
    responseData: string | Hex,
    sessionId: Hex,
    opts?: { skipProfitCheck?: boolean },
  ): Promise<Hex | null> {
    const wc = requireWallet();

    const responseHex: Hex = typeof responseData === 'string' && !responseData.startsWith('0x')
      ? (`0x${Buffer.from(responseData).toString('hex')}` as Hex)
      : (responseData as Hex);

    // Pre-flight profitability check
    if (!opts?.skipProfitCheck) {
      try {
        const result = await checkProfitability(requestId, responseHex, sessionId);
        if (!result.isProfitable) return null;
      } catch {
        return null; // Simulation failed — TX would revert
      }
    }

    // Estimate gas with buffer
    let estimatedGas: bigint;
    try {
      const data = encodeFunctionData({
        abi: HUB_ABI,
        functionName: 'fulfillRequest',
        args: [requestId, responseHex, sessionId],
      });
      const raw = await publicClient.estimateGas({
        account: wc.account!.address,
        to: hubAddress,
        data,
      });
      estimatedGas = raw * 120n / 100n;
    } catch {
      return null;
    }

    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'fulfillRequest',
        args: [requestId, responseHex, sessionId],
        account: wc.account!,
        chain: wc.chain,
        gas: estimatedGas,
      }),
    );
  }

  async function cancelRequest(requestId: Hex): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'cancelRequest',
        args: [requestId],
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  async function flushProtocolFeesToBuyback(): Promise<Hex> {
    const wc = requireWallet();
    return withTxMutex(() =>
      wc.writeContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: 'flushProtocolFeesToBuyback',
        account: wc.account!,
        chain: wc.chain,
      }),
    );
  }

  return {
    // Read
    getEndpointCount,
    getEndpoint,
    getEndpoints,
    getEndpointPrice,
    getRequest,
    getCallback,
    getBalance,
    getAgentStats,
    getHubStats,
    getEthPrice,
    estimateGasReimbursement,
    getProtocolFees,
    // Events
    watchRequests,
    watchConfigEvents,
    // Write
    depositUSDC,
    createRequest,
    createRequestWithCallback,
    fulfillRequest,
    cancelRequest,
    flushProtocolFeesToBuyback,
    checkProfitability,
  };
}

export type HubClient = ReturnType<typeof createHubClient>;
