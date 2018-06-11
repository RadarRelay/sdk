
import { ZeroEx } from '0x.js';
import { EventEmitter } from 'events';
import { RadarToken, RadarMarket } from '@radarrelay/types';
import {
  RadarRelayConfig,
  LightWalletConfig,
  RpcWalletConfig,
  InjectedWalletConfig,
  WalletType,
  WalletConfig,
  Account,
  AccountParams
} from './types';
import BigNumber from 'bignumber.js';
import request = require('request-promise');
import { TSMap } from 'typescript-map';

// SDK Classes
import { SDKInitLifeCycle, InitPriorityItem } from './SDKInitLifeCycle';
import { EventBus } from './EventEmitter';
import { Ethereum } from './ethereum';
import { Market } from './market';
import { Trade } from './trade';
import { RADAR_RELAY_ENDPOINTS } from './constants';
import { BaseAccount } from './accounts/BaseAccount';

BigNumber.config({ EXPONENTIAL_AT: 1e+9 });

/**
 * RadarRelay main SDK singleton
 */
export class RadarRelay<T extends BaseAccount> {

  public activeWalletType: WalletType;
  public events: EventBus;
  public account: T;
  public tokens: TSMap<string, RadarToken>;
  public markets: TSMap<string, Market<T>>;
  public zeroEx: ZeroEx;

  private _trade: Trade<T>;
  private _ethereum: Ethereum;
  private _apiEndpoint: string;
  private _wsEndpoint: string;
  private _networkId: number;
  private _prevApiEndpoint: string;
  private _markets: RadarMarket[];
  private _lifecycle: SDKInitLifeCycle;
  private _wallet: new (params: AccountParams) => T
;

  /**
   * The load priority list maintains the function call
   * priority for each init method in the RadarRelaySDK class.
   * It is utilized by the SDKInitLifeCycle
   *
   * This list is configurable if additional init methods are necessary
   */
  private loadPriorityList: InitPriorityItem[] = [
    {
      event: 'ethereumInitialized',
      func: this.initEthereumNetworkIdAsync
    }, {
      event: 'ethereumNetworkIdInitialized',
      func: this.initZeroEx
    }, {
      event: 'zeroExInitialized',
      func: this.initTokensAsync
    }, {
      event: 'tokensInitialized',
      func: this.initAccountAsync,
      args: [0] // pass default account of 0 to setAccount
    }, {
      event: 'accountInitialized',
      func: this.initTrade
    }, {
      event: 'tradeInitialized',
      func: this.initMarketsAsync
    }, {
      event: 'marketsInitialized',
      func: undefined
    }];

  /**
   * SDK instance
   *
   * @param {RadarRelayConfig}  config  sdk config
   */
  constructor(rrConfig: RadarRelayConfig, wallet: new (params: AccountParams) => T) {
    // set the api/ws endpoint outside
    // of the init _lifecycle
    this._apiEndpoint = rrConfig.endpoint;
    this._wsEndpoint = rrConfig.websocketEndpoint;
    this._wallet = wallet;

    // instantiate event handler
    this.events = new EventEmitter();

    // instantiate ethereum class
    this._ethereum = new Ethereum();

    // setup the _lifecycle
    this._lifecycle = new SDKInitLifeCycle(this.events, this.loadPriorityList, rrConfig.sdkInitializationTimeout);
    this._lifecycle.setup(this);
  }

  /**
   * Initialize the SDK
   *
   * @param {WalletConfig}  config  wallet config
   */
  public async initialize(walletConfig: WalletConfig, walletType: WalletType): Promise<RadarRelay<T>> {
    this.activeWalletType = walletType;
    await this._ethereum.setProvider(this.activeWalletType, walletConfig);

    if (this.activeWalletType === WalletType.Injected && !((walletConfig as InjectedWalletConfig).web3)) {
      // Adjust Radar API endpoint accordingly
      const { endpoint, websocketEndpoint } = RADAR_RELAY_ENDPOINTS(await this._ethereum.getNetworkIdAsync());
      this._apiEndpoint = endpoint;
      this._wsEndpoint = websocketEndpoint;
    }

    this.getCallback('ethereumInitialized', this._ethereum);

    return this;
  }

  // --- not user configurable below this line --- //

  private async initAccountAsync(address: string | number): Promise<string | boolean> {
    await this._ethereum.setDefaultAccount(address);
    this.account = new this._wallet({
      ethereum: this._ethereum,
      events: this.events,
      zeroEx: this.zeroEx,
      endpoint: this._apiEndpoint,
      tokens: this.tokens
    });
    return this.getCallback('accountInitialized', this.account);
  }

  private async initEthereumNetworkIdAsync(): Promise<string | boolean> {
    this._networkId = await this._ethereum.getNetworkIdAsync.apply(this._ethereum);
    return this.getCallback('ethereumNetworkIdInitialized', this._networkId);
  }

  private initZeroEx(): Promise<string | boolean> {
    this.zeroEx = new ZeroEx(this._ethereum.web3.currentProvider, {
      networkId: this._networkId
    });
    return this.getCallback('zeroExInitialized', this.zeroEx);
  }

  private initTrade(): Promise<string | boolean> {
    this._trade = new Trade<T>(this.zeroEx, this._apiEndpoint, this.account, this.events, this.tokens);
    return this.getCallback('tradeInitialized', this._trade);
  }

  private async initTokensAsync(): Promise<string | boolean> {
    // only fetch if not already fetched
    if (this._prevApiEndpoint !== this._apiEndpoint) {
      const tokens = JSON.parse(await request.get(`${this._apiEndpoint}/tokens`));
      this.tokens = new TSMap();
      tokens.map(token => {
        this.tokens.set(token.address, token);
      });
    }
    // todo index by address
    return this.getCallback('tokensInitialized', this.tokens);
  }

  private async initMarketsAsync(): Promise<string | boolean> {
    // only fetch if not already fetched
    if (this._prevApiEndpoint !== this._apiEndpoint) {
      this._markets = JSON.parse(await request.get(`${this._apiEndpoint}/markets`));
    }
    // TODO probably not the best place for this
    this._prevApiEndpoint = this._apiEndpoint;
    this.markets = new TSMap();
    this._markets.map(market => {
      this.markets.set(market.id, new Market(
        market, this._apiEndpoint, this._wsEndpoint, this._trade
      ));
    });

    return this.getCallback('marketsInitialized', this.markets);
  }

  private getCallback(event, data): Promise<string | boolean> {
    const callback = this._lifecycle.promise(event);
    this.events.emit(event, data);
    return callback;
  }
}
