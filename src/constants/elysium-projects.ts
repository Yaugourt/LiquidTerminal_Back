/**
 * Elysium ecosystem directory: the projects building on Elysium, their
 * category, status, links and the contracts they run on the testnet.
 *
 * The off-chain part (names, categories, statuses, links, logos) was taken
 * once from elysiumeco.xyz, a community index, with its author's permission.
 * Every figure shown for a project is computed by us from the chain (see
 * ElysiumEcosystemService); only this list is maintained by hand.
 *
 * Status: powers (core infrastructure), live, testnet (contracts deployed),
 * verifying, announced, exploring.
 */

export type ElysiumProjectStatus =
  | 'powers'
  | 'live'
  | 'testnet'
  | 'verifying'
  | 'announced'
  | 'exploring';

export interface ElysiumProjectContract {
  /** Lowercase address. */
  address: string;
  label: string;
}

export interface ElysiumProject {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  status: ElysiumProjectStatus;
  statusLabel: string;
  /** Path under the front's public folder. */
  logo: string | null;
  url: string | null;
  urlLabel: string | null;
  x: string | null;
  contracts: ElysiumProjectContract[];
  /** Launchpad name as used for its tokens, when the project is a token launchpad we decode. */
  launchpad?: string;
}

export const ELYSIUM_PROJECTS: ElysiumProject[] = [
  {
    slug: 'ascend',
    name: 'Ascend',
    tagline: 'Token launch & lifecycle',
    description:
      "Launchpad for Elysium. Creators earn part of the trading fees on their token, and there's no Ascend token.",
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/ascend.jpg',
    url: 'https://ascendlaunch.xyz/',
    urlLabel: 'Launch',
    x: 'https://x.com/AscendLaunch',
    contracts: [
      {
        address: '0x90332b0ecbb2c9517f405627b0dd5d5265246563',
        label: 'UniversalRouter',
      },
      {
        address: '0xe2f6254508deb93da081837f545e0baf7b00d8e9',
        label: 'AscendLaunchpad',
      },
      {
        address: '0xbd903344f61e5e4b738108bc7069c4a0afb5e6aa',
        label: 'AscendRouter',
      },
      {
        address: '0x3250c3effbf556586e62200e0ae929c8adf01ad6',
        label: 'CLPositionManager',
      },
      {
        address: '0x1d94ea6c622d13555abc101239b90712c6e955b1',
        label: 'AscendYieldVault',
      },
      {
        address: '0x1e28dfb3bb710a2c181b6a63276a7138569e7a4e',
        label: 'AscendCtoRegistry',
      },
      {
        address: '0x33006c19f7aeda679ef9097d9a6684a064e9a91f',
        label: 'AscendFeeController',
      },
      {
        address: '0x12e84206cb53ae0df055482ebc4658635096e1aa',
        label: 'CLPoolManager',
      },
      {
        address: '0x6ab00610139f03452fc85b531dda0e45c1337c97',
        label: 'AscendCreate2Factory',
      },
      {
        address: '0xa88048e8c9ef4a6a390f29a5b70f506057137cbf',
        label: 'StakingQuoteOracle',
      },
      {
        address: '0x0a009c1141c96491d40f35f67169fa6e9e4dd8db',
        label: 'YieldRouter',
      },
      {
        address: '0x0029967225ceec74bd05647e567d3875f0665364',
        label: 'ListingDesk',
      },
      {
        address: '0x8693f42772fca33dbec00104fab5662b66a70eb4',
        label: 'BurnSink',
      },
      {
        address: '0x70a8cd8a4026a9d803cb66671debe674eb8d787e',
        label: 'StakerDistributor',
      },
      {
        address: '0x4b723d2bb73969fba85717ac735e6324bb3ea7db',
        label: 'AscendQuoter',
      },
      {
        address: '0xcc9fae0dfe8a2a63d4889f011dfb72668464e3a3',
        label: 'CLQuoter',
      },
    ],
  },
  {
    slug: 'conduit',
    name: 'Conduit',
    tagline: 'Sequencer · G2',
    description:
      'Runs the Elysium sequencer on its G2 stack, according to the testnet launch announcement.',
    category: 'Infrastructure',
    status: 'powers',
    statusLabel: 'Powers Elysium',
    logo: '/elysium/logos/conduit.jpg',
    url: 'https://conduit.xyz',
    urlLabel: 'Open',
    x: 'https://x.com/conduitxyz',
    contracts: [],
  },
  {
    slug: 'arbitrum-orbit',
    name: 'Arbitrum Orbit',
    tagline: 'Rollup framework',
    description:
      'The framework Elysium is built on. Transactions run on Elysium and settle to HyperEVM.',
    category: 'Infrastructure',
    status: 'powers',
    statusLabel: 'Powers Elysium',
    logo: '/elysium/logos/arbitrum.jpg',
    url: 'https://arbitrum.io/orbit',
    urlLabel: 'Open',
    x: 'https://x.com/arbitrum',
    contracts: [
      {
        address: '0x00000000000000000000000000000000000a4b05',
        label: 'ArbOS',
      },
      {
        address: '0x000000000000000000000000000000000000006e',
        label: 'ArbRetryableTx',
      },
      {
        address: '0x0000000000000000000000000000000000000064',
        label: 'ArbSys',
      },
      {
        address: '0x0000000000000000000000000000000000000070',
        label: 'ArbOwner',
      },
      {
        address: '0x00000000000000000000000000000000000000ff',
        label: 'ArbDebug',
      },
      {
        address: '0x00000000000000000000000000000000000000c9',
        label: 'NodeInterfaceDebug',
      },
      {
        address: '0x00000000000000000000000000000000000000c8',
        label: 'NodeInterface',
      },
      {
        address: '0x000000000000000000000000000000000000006f',
        label: 'ArbStatistics',
      },
      {
        address: '0x000000000000000000000000000000000000006d',
        label: 'ArbAggregator',
      },
      {
        address: '0x000000000000000000000000000000000000006c',
        label: 'ArbGasInfo',
      },
      {
        address: '0x000000000000000000000000000000000000006b',
        label: 'ArbOwnerPublic',
      },
      {
        address: '0x0000000000000000000000000000000000000069',
        label: 'ArbosTest',
      },
      {
        address: '0x0000000000000000000000000000000000000068',
        label: 'ArbFunctionTable',
      },
      {
        address: '0x0000000000000000000000000000000000000067',
        label: 'ArbBLS',
      },
      {
        address: '0x0000000000000000000000000000000000000066',
        label: 'ArbAddressTable',
      },
      {
        address: '0x0000000000000000000000000000000000000065',
        label: 'ArbInfo',
      },
    ],
  },
  {
    slug: 'hypedexer',
    name: 'Hypedexer',
    tagline: 'Data platform · RPC',
    description:
      'A Hyperliquid data service (fills, trades, order books, APIs). For the Elysium testnet it runs a free public RPC, serves indexed chain data, and publishes an open-source setup to run your own node.',
    category: 'Infrastructure',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/hypedexer.jpg',
    url: 'https://hypedexer.com',
    urlLabel: 'Open',
    x: 'https://x.com/hypedexer',
    contracts: [],
  },
  {
    slug: 'chainstack',
    name: 'Chainstack',
    tagline: 'RPC nodes',
    description:
      'A major node provider, now serving the Elysium testnet: shared and dedicated RPC nodes, with archive mode and debug calls for builders.',
    category: 'Infrastructure',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/chainstack.jpg',
    url: 'https://chainstack.com/chainstack-introduces-elysium-support/',
    urlLabel: 'Open',
    x: 'https://x.com/ChainstackHQ',
    contracts: [],
  },
  {
    slug: 'signal',
    launchpad: 'Signal',
    name: 'Signal',
    tagline: 'Curve launches',
    description:
      'A HyperEVM trading app and launchpad with a version on Elysium, where tokens start on a price curve and then graduate to a pool. On HyperEVM, its fees buy back $SIGNAL, and 70% of it is burned.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/signal.jpg',
    url: 'https://elysium.signal.family/launches',
    urlLabel: 'Launch',
    x: 'https://x.com/SignalFam',
    contracts: [
      {
        address: '0x75d98c98f92d1f5d65ca6a962f36476be34c64ae',
        label: 'SignalCurveHypeRouter',
      },
      {
        address: '0xe7d6263e09a4691d58dca528043efdfeec4db2c0',
        label: 'SignalCurveQuoteFactory',
      },
      {
        address: '0xc8e6fab2c78b6e209ab355c248568e049dc30ad5',
        label: 'SignalProjectXAverageGuard',
      },
      {
        address: '0x58269ca65cedf99ea9613edffbb9a008a497fa52',
        label: 'SignalRamsesCurveProcessor',
      },
      {
        address: '0xc5fbd52fddc9b57869ed088b9281d5e5f05807bc',
        label: 'SignalRamsesCurve',
      },
      {
        address: '0xcb4f80eb7092b544fdd88b7f6e4d895f99eeb366',
        label: 'SignalRamsesCurveToken',
      },
      {
        address: '0x3e224a8bd17e8cea0a8a3e3494ab677bff4ca360',
        label: 'SignalElysiumAnchor',
      },
      {
        address: '0x645f45ac6b7701a53049e70c8eec608007917b36',
        label: 'SignalProjectXV2Router',
      },
      {
        address: '0xc635adae7c46f0e638633b6977cdbe333fca9b98',
        label: 'SignalCurveImplementationBuilder',
      },
      {
        address: '0x89593cf10d68a0d7d0c2bba3ced12f55fad0adeb',
        label: 'Signal launch factory',
      },
      {
        address: '0x9ecd72d85ad8a0fb1799b1599d85a6378969cd78',
        label: 'Contract used by its app',
      },
      {
        address: '0x4b9ee7d06a094c160808d58fea9d51e1a0a6d62b',
        label: 'Signal Holders Proof',
      },
    ],
  },
  {
    slug: 'chainzy',
    launchpad: 'Chainzy',
    name: 'Chainzy',
    tagline: 'Token launches · V3 liquidity',
    description:
      'A Hyperliquid trading and discovery hub whose launch contracts are on the Elysium testnet: a token factory, a Uniswap V3 setup, a liquidity locker and a buyback contract.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/chainzy.jpg',
    url: 'https://chainzy.io/elysium-testnet/hub?ref=ELYSIUMECO',
    urlLabel: 'Launch',
    x: 'https://x.com/ChainzyLabs',
    contracts: [
      {
        address: '0x01c90bced829cc4c7d66ddcda905b8c012348888',
        label: 'LaunchToken',
      },
      {
        address: '0x6a3da5ae2be6785641142d21d4042cfda30c8888',
        label: 'PermanentLiquidityLocker',
      },
      {
        address: '0x4da0a4e783bcbd478ef8f7fbb20583ccbf918888',
        label: 'ChainzyEVMFactory',
      },
      {
        address: '0x9c820a975526915c579a3c582a0c8bad32148888',
        label: 'SharedCreatorSupplyLocker',
      },
      {
        address: '0x2eb712a3b8081d2a3105422c5f766650f9208888',
        label: 'ChainzyRouter',
      },
      {
        address: '0xe8d3ea1dc7c66b91881726e985c84bf4e4708888',
        label: 'ConfiguredFeeRouter',
      },
      {
        address: '0x464125cec2b1010373d5a0db2eb09dde31568888',
        label: 'RouterBuybackAdapter',
      },
      {
        address: '0xc3bb98d0e5772f57c9e80ba00e7f2ecce94e8888',
        label: 'ChainzyHyperEVMSuiteBinder',
      },
      {
        address: '0x1b03d9234032adc0e6b2f18c0acaaa96a8728888',
        label: 'ImmediateV3LiquidityDeployer',
      },
      {
        address: '0xefe90128517cfca1d5fa97a893d500daf0db8888',
        label: 'SharedLaunchTokenDeployer',
      },
      {
        address: '0xe987cb696c2bd41e4fac7bcfa19b344d37078888',
        label: 'TokenTreasuryFactory',
      },
      {
        address: '0x7b998f4d9fce4d3556ac3a8cefff146a4b518888',
        label: 'StrategyRegistry',
      },
    ],
  },
  {
    slug: 'perpme',
    name: 'PerpMe',
    tagline: 'Token launches',
    description:
      'A launchpad that opened on the Elysium testnet on Oct 1. Tokens launch in one transaction, paired with HYPE, with the liquidity held by a contract.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/perpme.jpg',
    url: 'https://perpme.fun/elysium',
    urlLabel: 'Launch',
    x: 'https://x.com/perpmefun',
    contracts: [
      {
        address: '0xd218817cfcca3ae397de3a6e66889d4fb4b9e2d1',
        label: 'SwapRouter',
      },
      {
        address: '0x1186defcaf121da6e773425fec0814608798e792',
        label: 'UniswapV3Factory',
      },
      {
        address: '0xc627cf00e4ac649db40348c515a500c534cfa187',
        label: 'PerpMe contract',
      },
      {
        address: '0x2a2b7645839e55a1683e7fd64436aeed5ed2793c',
        label: 'Uniswap V3 setup',
      },
      {
        address: '0x5644d1043998e602f582e3b282f1185102a6499e',
        label: 'PerpMe launchpad',
      },
      {
        address: '0xc6c3a8876299a3b7cc1bfbe8fd819d7b12f301c8',
        label: 'Elysium Genesis token',
      },
      {
        address: '0xd85fc505093a6b4a2afe6ce5069ce6e4e0c9ea83',
        label: 'NonfungiblePositionManager',
      },
      {
        address: '0x60f94a264779d5f957b36f54d90afb53693b56d4',
        label: 'Contract used by its app',
      },
    ],
  },
  {
    slug: 'corepad',
    launchpad: 'CorePad',
    name: 'CorePad',
    tagline: 'Curve launches to HyperCore',
    description:
      'A launchpad running on the Elysium testnet. Tokens sell on a price curve on Elysium; once 800M are sold the pool freezes and the token moves on to an order book on HyperCore.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/corepad.jpg',
    url: 'https://corepad.app',
    urlLabel: 'Launch',
    x: 'https://x.com/CorePad_hl',
    contracts: [
      {
        address: '0x8547e759715b1bbd67291e06395e0c5ffea4de13',
        label: 'CorePadFactory',
      },
      {
        address: '0x9baa610a43b8f62f0d014af4eefb0df44af87e37',
        label: 'ElysiumBridgeAdapter',
      },
      {
        address: '0x2cde65c326e61cd9619f4f4f08d20eac0015559c',
        label: 'Settlement',
      },
    ],
  },
  {
    slug: 'oxley',
    name: 'Oxley',
    tagline: 'Deal markets',
    description:
      'Building Deal Markets on Elysium: new spot assets launch on Elysium and work toward a HyperCore listing. Its testnet bridge is live, and so are its auction and launch contracts.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/oxley.jpg',
    url: 'https://oxley.fun',
    urlLabel: 'Launch',
    x: 'https://x.com/oxleydotfun',
    contracts: [
      {
        address: '0xa4ce6e6c719f7fb524230c367948039b078683e4',
        label: 'OxyUsdc',
      },
      {
        address: '0x329a12f7f9226dd5fcac864b807305a5500612e4',
        label: 'ElysiumReserveCurve',
      },
      {
        address: '0xc65372a9d4c4c65f0f9c5a11e138cc869052cd42',
        label: 'ElysiumCoin',
      },
      {
        address: '0x0000621e335a05a619d1b5a123cc4180e03040fb',
        label: 'ContinuousClearingAuction',
      },
      {
        address: '0xae4df7c90a6981ab1c7470f0407f7e4d471c6218',
        label: 'ElysiumFeeRouter',
      },
      {
        address: '0xd92ec81451b132b43f6453dffa71aa2d0648636d',
        label: 'ElysiumProtocolCoordinator',
      },
      {
        address: '0xb923bcf33066c73647aac539d1e0a39419bd744a',
        label: 'ElysiumFundedCcaLaunchController',
      },
      {
        address: '0x1b2a4547adf2d2076ae66fc32f63b29862db54dc',
        label: 'ElysiumDealRegistry',
      },
      {
        address: '0x3d2ac47e12c69876e1e429cd467231fbabcc02e3',
        label: 'ElysiumCoinFactory',
      },
      {
        address: '0xa219807620da0a323ff598b4f113cd32e2f6cca2',
        label: 'ElysiumEntryController',
      },
      {
        address: '0x8bb47f071dbc60a4f322166c75660bcd4e693815',
        label: 'ElysiumAuctionGasEscrow',
      },
      {
        address: '0x874dfec5b70ecbe57ab0f6eab5936ccbc43e2339',
        label: 'ElysiumCcaLaunchController',
      },
      {
        address: '0x1ea9f1d7105de9e3e1f8477ddb48a2d0d92856ad',
        label: 'ElysiumReserveLaunchController',
      },
      {
        address: '0xe9f328c96411cd3fe924fa5e6dcd1cc15b2bb279',
        label: 'ElysiumLaunchEscrow',
      },
      {
        address: '0x740960814d07bcb78cbf6a0d255475a61fa4522f',
        label: 'ElysiumUniswapCcaAdapter',
      },
      {
        address: '0xe7955751de339eab8e9c1e4d4000dd487c74cc81',
        label: 'ElysiumReserveVault',
      },
      {
        address: '0x963cff6141f1afeaf32a745a58a9e6ceebbccf77',
        label: 'ElysiumOxyAuctionReleaseManifest',
      },
      {
        address: '0xcef2e265791c06e40b2ec00ef8e6f2cafaf4533d',
        label: 'ElysiumReleaseManifest',
      },
      {
        address: '0xe3bdeba5b5771c835e59e6100259d139235817c5',
        label: 'ElysiumUsdcPriceAdapter',
      },
      {
        address: '0xc9d57edf2862ccb3b203cf58afe8b3c230548c5d',
        label: 'ElysiumLotStaking',
      },
      {
        address: '0xdf31317491d46be9ea8849f8d0b62a251c545dcf',
        label: 'ElysiumCcaBidPriceHook',
      },
      {
        address: '0xa861e4886ff2e71f8b8aed09ff68f8eeafb58e17',
        label: 'ContinuousClearingAuctionFactory',
      },
      {
        address: '0x1114d4e90f6810285830a57ea52e7072837e6f0d',
        label: 'ElysiumOxyPriceAdapter',
      },
      {
        address: '0x848237c145928d744122797108fef43ef1a13e10',
        label: 'ElysiumNoLotRebate',
      },
      {
        address: '0xeece6d3985e32dcd0d59c8a95b4a2bef745f506d',
        label: 'LaunchCampaigns (v2)',
      },
      {
        address: '0x5f2e682c5b60ddedae1a624ffb6f51b15eca215d',
        label: 'Coordinator (v2)',
      },
      {
        address: '0x9fe6e374f26bc80e5001a000ed6234844b3117b6',
        label: 'CoinFactory (v2)',
      },
      {
        address: '0x6acc92ba104446facd7aebe113f907b1d0874d0b',
        label: 'Registry (v2)',
      },
      {
        address: '0xe5a2d6575c63bcf43b044ba6da509bd8d1dd9c60',
        label: 'BondEscrow (v2)',
      },
      {
        address: '0x1d2da15246f5cb5016f49da0140456a696bd60a4',
        label: 'CreatorAccountFactory (v2)',
      },
    ],
  },
  {
    slug: 'hyperflip',
    name: 'Hyperflip',
    tagline: 'Combo bets on HIP-4 outcomes',
    description:
      "Lets you stack several of Hyperliquid's HIP-4 outcome markets into one bet, and the payout grows with each one you add. On Elysium they've deployed a ParlayVault and one contract per bet leg.",
    category: 'Prediction markets',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/hyperflip.jpg',
    url: 'https://hyperflip.xyz',
    urlLabel: 'Bet',
    x: 'https://x.com/hyperflip_xyz',
    contracts: [
      {
        address: '0xead53f4c662c69ed31ae2d9054d6b0a4ae1a00d6',
        label: 'ParlayVault',
      },
      {
        address: '0xea83c9450b5323103f98c285127c2d7d6bc20476',
        label: 'OutcomeLeg',
      },
      {
        address: '0xe983796051af586abf1c47a51890750ff2704744',
        label: 'Contract used by its app',
      },
    ],
  },
  {
    slug: 'temporal-finance',
    name: 'Temporal Finance',
    tagline: 'Options on perps',
    description:
      'Options on perps, for example to protect a perp position from liquidation, quoted through requests for quotes. Their test venue runs on the Elysium testnet with test funds only.',
    category: 'Derivatives',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/temporal.jpg',
    url: 'https://perp-options-rfq-production.up.railway.app',
    urlLabel: 'Trade',
    x: 'https://x.com/temporalfinance',
    contracts: [
      {
        address: '0x5dc52db26ccddac2fd525d137928984d9e4051cc',
        label: 'Temporal ledger',
      },
      {
        address: '0xf14e42fb412ad874ce5b6c99bf16ef32ec9b2f8a',
        label: 'Temporal ledger logic',
      },
      {
        address: '0xd0a7d6995531d645d335deaf89c6bf2da4bf9793',
        label: 'Temporal quote front',
      },
    ],
  },
  {
    slug: 'dex-da-costa',
    name: 'Dex Da Costa',
    tagline: 'HYPE/USDC exchange',
    description: 'A small independent exchange for swapping HYPE and USDC on the Elysium testnet.',
    category: 'DEX',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/dexdacosta.svg',
    url: 'https://dex-da-costa-elysium.vercel.app',
    urlLabel: 'Trade',
    x: 'https://x.com/ThePhunky1',
    contracts: [
      {
        address: '0x72d435b8030a5195bdb7594edea1ff315b9994c7',
        label: 'Dex Da Costa exchange',
      },
      {
        address: '0xfa456ad175f0bdb9285960720b4b6e8f25deb3f9',
        label: 'Dex Da Costa factory',
      },
      {
        address: '0xff5681eb95bbacfbb334f80fcdbc31fb59f22332',
        label: 'Dex Da Costa wrapped HYPE',
      },
      {
        address: '0xfb3a6f0b6ec7837eaf298efe0e5dc534bf1d746a',
        label: 'Uniswap V2',
      },
    ],
  },
  {
    slug: 'elypact',
    name: 'Elypact',
    tagline: 'OTC trading',
    description:
      'An OTC trading app: fixed-price buy and sell offers, open to everyone or private to one wallet, with the tokens held in escrow by a contract. Live on the Elysium testnet with test tokens.',
    category: 'DeFi',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/elypact.jpg',
    url: 'https://elypact.com',
    urlLabel: 'Trade',
    x: 'https://x.com/Elypact',
    contracts: [
      {
        address: '0xbf895329cf6278687bf62cfe881e6e454418e90a',
        label: 'ElyPactV5',
      },
      {
        address: '0xe22611b5707826abc6ad37074f99519642571d53',
        label: 'Test token NEST',
      },
      {
        address: '0x7edd34d6cc349b68beec26d5e8891d338d7f99a2',
        label: 'Test token KNTQ',
      },
      {
        address: '0x4b71068ae625373ace4b9d38aabd102463ab7650',
        label: 'Test token USDC',
      },
      {
        address: '0xa912405b35a50ea7147faebd4c3c46f2ac84a922',
        label: 'Test token PURR',
      },
      {
        address: '0x5c297c771fe9768f3ee5d69d29b50a722165e903',
        label: 'Test token SIGNAL',
      },
      {
        address: '0x4be28040449d5fd7836ea8e0ac9103a444909f7a',
        label: 'Test token PERPME',
      },
      {
        address: '0x6ae299cd735d83bbbc51e5906c1e49e2a99b2a28',
        label: 'Test token RAM',
      },
      {
        address: '0xa24ce32b0242ab1a86a5f106b024665c952be4d3',
        label: 'Test token CHAMELEON',
      },
      {
        address: '0x56052ba0079146b66cd9674e7e35411cb4b760cf',
        label: 'Test token EGG',
      },
      {
        address: '0xb256d6267473e644eec13f10abfffae3589e7d9d',
        label: 'Test token USDT',
      },
    ],
  },
  {
    slug: 'atlashl',
    name: 'AtlasHL',
    tagline: 'NFT marketplace',
    description:
      "An NFT marketplace from HyperEVM with a version and a launchpad on Elysium, built on OpenSea's open-source Seaport contracts. Its testnet collection is Atlassians, 500 items.",
    category: 'NFT',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/atlashl.jpg',
    url: 'https://elysium.atlashl.xyz',
    urlLabel: 'Collect',
    x: 'https://x.com/AtlasHL',
    contracts: [
      {
        address: '0x973100aeff6452e657b1b8dffcf2606c47ca50d1',
        label: 'SeaDrop',
      },
      {
        address: '0x3a793699cc741ac76a53a69ebad40af7a05dd243',
        label: 'ERC721SeaDrop',
      },
      {
        address: '0x2fc1a9629511b597046b3ca90b22db162acba947',
        label: 'AtlasHL',
      },
      {
        address: '0x6c98579ba151640f18969b9d17f9507a8fc70295',
        label: 'Atlassians',
      },
      {
        address: '0xd504657980a4e493dc9a074b81f485109a088d6f',
        label: 'MirrorERC721',
      },
      {
        address: '0x786e75c83ca74ea98504c11cef7e22427b721746',
        label: 'ConduitController',
      },
      {
        address: '0x39bbd99f1a2d6e6c8ae35862dbcec872ca9b4ace',
        label: 'Ace Apes',
      },
    ],
  },
  {
    slug: 'kalos',
    name: 'Kalos',
    tagline: 'NFT marketplace',
    description:
      'An NFT marketplace in testnet preview on Elysium: mint and trade collections, make offers and chat with other holders. A points program and a token-trading view are planned.',
    category: 'NFT',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/kalos-2026-10.jpg',
    url: 'https://www.kalos.fun/refer/elysiumeco',
    urlLabel: 'Collect',
    x: 'https://x.com/kalosfun',
    contracts: [
      {
        address: '0x0ff8b7afc288ac42f82320f54a49c400f233bf07',
        label: 'Kalos marketplace',
      },
      {
        address: '0xeb619d51c0dfa4fc02c4b9220e7a6c1fc00e943a',
        label: 'Kalos drops factory',
      },
      {
        address: '0x519e1951ac1deb54a7ac18c5c4178a80642fb85b',
        label: 'Kalos drop implementation',
      },
      {
        address: '0x8e335a3f9600bebb6bb7b8118598bf9cf306be06',
        label: 'Kalos Genesis',
      },
      {
        address: '0x265df1239742185e3c3ffbbfa10b1fa71a83cab3',
        label: 'Marble Studies',
      },
      {
        address: '0x84fd503c2e3d5e15b9ad955517e3a407804ce3df',
        label: 'Little Legends',
      },
      {
        address: '0x28f987298731942976786e393686e9e1d47b456d',
        label: 'Elysium Realms',
      },
      {
        address: '0x41051f27c609db70af05b7128f15155dc8e49ac7',
        label: 'Kalos wrapped HYPE',
      },
      {
        address: '0x17032b40b733801f5c6995b692d3a68f7c9afc06',
        label: 'Kalos NFT gamble',
      },
    ],
  },
  {
    slug: 'dystomfers',
    name: 'DystoMfers',
    tagline: 'NFT auctions & raffles',
    description:
      'NFT tools that now support Elysium testnet: run auctions and raffles, swap NFTs peer to peer, and sell several NFTs together as a bundle.',
    category: 'NFT',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/dystomfers.jpg',
    url: 'https://dystomfers.art/',
    urlLabel: 'Collect',
    x: 'https://x.com/dystomfersOnHL',
    contracts: [
      {
        address: '0xf49a5d1df925028a77514914d32210c1c88754e8',
        label: 'DystoMfers auctions',
      },
      {
        address: '0xf2b723af1b70b5cedabaf4891912ad1fca875ede',
        label: 'DystoMfers auctions view',
      },
      {
        address: '0xffffa0abf27aa3cc62090aa2ca1e607a7fe46d97',
        label: 'DystoMfers raffles',
      },
      {
        address: '0x757ffd0419320619ecc8ac6126eb1bb550acd134',
        label: 'DystoMfers raffle picker',
      },
      {
        address: '0xa8207a6f5b22cd6d40f2eef34a156fd44c57aee3',
        label: 'DystoMfers raffles view',
      },
      {
        address: '0x9885f00fe43d0447315156c55bdb13b23386e88f',
        label: 'DystoMfers multicall',
      },
    ],
  },
  {
    slug: 'clash-for-elysium',
    name: 'Clash for Elysium',
    tagline: 'On-chain battle royale',
    description:
      "A battle royale where you pick a hero and every move is a transaction on the Elysium testnet. Fights last two minutes and the last one standing wins. It's in beta: you can watch the live arena and practise against bots, and playing on-chain from the site is coming next. No prizes, only a leaderboard.",
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/clash.jpg',
    url: 'https://clashforelysium.xyz',
    urlLabel: 'Play',
    x: 'https://x.com/clashforelysium',
    contracts: [
      {
        address: '0xa2b3119b3361ed0a61c6fa7ae8cad7f2eb786f93',
        label: 'Contract used by its app',
      },
      {
        address: '0x14ae215bf9d092a954c0dcdc2e1d3c5f92c90056',
        label: 'Clash for Elysium game',
      },
    ],
  },
  {
    slug: 'elysa-fun',
    name: 'ELYSA.FUN',
    tagline: 'Casino games',
    description:
      'A game room on the Elysium testnet with bets and payouts in HYPE: crash, slots, coinflip, Blob Royale, tug of war and card duels, each with its own contract.',
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/elysa.jpg',
    url: 'https://elysa.fun/?ref=0xb1c29629cb155afd2ffa830a50fd451db0c95a71',
    urlLabel: 'Play',
    x: 'https://x.com/playelysa',
    contracts: [
      {
        address: '0xc609c10210ed2d753b30e0538215203277b79a4b',
        label: 'ElysaFlip',
      },
      {
        address: '0x27b637c6ce158ddbb562f567031e0d0078fd5acd',
        label: 'ElysaCrash',
      },
      {
        address: '0xa22cf8f84a199776cd351e8101c4a1872ee115eb',
        label: 'ElysaSlots',
      },
      {
        address: '0x8f8610fa3e5bdca92aecdc554be3deb5f796cda4',
        label: 'ElysaTug',
      },
      {
        address: '0xf41281f76524f37785c2ebac9920f02d2bfd462b',
        label: 'ElysaRoyale',
      },
      {
        address: '0x03de2040c625e7f2dcf8d2f7eebefbd25220d3b7',
        label: 'ElysaClash',
      },
      {
        address: '0xb17d55f7e2e992a9b68fb2aba17bec763b0a8e65',
        label: 'ElysaVault',
      },
      {
        address: '0x1ca57f4259a92bbcbc3548166c9e6e3bdceef1dc',
        label: 'ElysaReserve',
      },
      {
        address: '0x9f1a8df3ee766b209bd217a0d83fc8c00ff40d3c',
        label: 'FeeRouter',
      },
    ],
  },
  {
    slug: 'frog-flip',
    name: 'Frog Flip',
    tagline: 'Coin flip',
    description:
      'A coin flip on the Elysium testnet. You pick a side, flip, and can check the result afterwards.',
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/frogflip.svg',
    url: 'https://frog-flip.vercel.app',
    urlLabel: 'Play',
    x: 'https://x.com/KhattaDahi',
    contracts: [
      {
        address: '0x5a84ce820b375e23b08c8499dd24bf2c54001cd7',
        label: 'Frog Flip game',
      },
      {
        address: '0x8463ec335192b4b0e5cc88ebf35e1b1121c875f3',
        label: 'Frog Flip contract',
      },
      {
        address: '0x2cae9bac2d5b500aaa860cce0a3a20d387f384d4',
        label: 'Frog Flip proxy',
      },
    ],
  },
  {
    slug: 'eloscape',
    name: 'Eloscape',
    tagline: 'Mining game',
    description:
      "A mining game: each round, players deploy HYPE on squares of a grid, the round settles with on-chain randomness, and ELO, its token, is mined along the way. ELO can be staked for a share of the protocol's revenue. Its testnet version runs on Elysium.",
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/eloscape.png',
    url: 'https://eloscape.com',
    urlLabel: 'Play',
    x: 'https://x.com/eloscapeHQ',
    contracts: [
      {
        address: '0x4d844ab6772f12c116ceca8c506063b125d65165',
        label: 'Eloscape game',
      },
      {
        address: '0x4b02abdeb08b58a1309491c133a07909acd81a13',
        label: 'ELO token',
      },
      {
        address: '0x2e4bca36bebf30fae90a698ed53d6bb8c25f3340',
        label: 'Randomness oracle',
      },
      {
        address: '0x99c87af19b7beabbdcee1aefc109c8f7a8beeecc',
        label: 'Round intake',
      },
    ],
  },
  {
    slug: 'liquid-terminal',
    name: 'Liquid Terminal',
    tagline: 'Elysium dashboard',
    description:
      'A dashboard for the Elysium testnet: blocks, contracts, DEX pools, token launches, bridge flows and reserves, and the batches settled on HyperEVM. Builders can also simulate a call or a deployment before signing it. The code is open source.',
    category: 'Analytics',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/liquidterminal.jpg',
    url: 'https://liquidterminal.xyz/elysium',
    urlLabel: 'Open',
    x: 'https://x.com/liquidterminal',
    contracts: [],
  },
  {
    slug: 'elysium-intel',
    name: 'Elysium Intel',
    tagline: 'Testnet tracker',
    description:
      'A community tracker of every team deploying on the Elysium testnet, with usage measured from the chain and updated every hour.',
    category: 'Analytics',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/elysiumintel.svg',
    url: 'https://elysium-testnet.vercel.app',
    urlLabel: 'Open',
    x: null,
    contracts: [],
  },
  {
    slug: 'elysium-ecosystem-hub',
    name: 'Elysium Ecosystem Hub',
    tagline: 'Community directory',
    description:
      'A community-run directory of apps on the Elysium testnet, where builders can submit their project.',
    category: 'Tools',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: null,
    url: 'https://elysium-ecosystem-hub.vercel.app',
    urlLabel: 'Open',
    x: 'https://x.com/NemeremIgweze',
    contracts: [],
  },
  {
    slug: 'launchpath',
    name: 'LaunchPath',
    tagline: 'Ascend launch tracker',
    description:
      "An unofficial page that follows Ascend's four stages to a HyperCore listing, with costs and timings read live from the testnet.",
    category: 'Analytics',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: null,
    url: 'https://launchpath-live.vercel.app',
    urlLabel: 'Open',
    x: 'https://x.com/0xmeto_',
    contracts: [],
  },
  {
    slug: 'elysium-vs-hyperevm',
    name: 'Elysium vs HyperEVM',
    tagline: 'Open-source benchmark',
    description:
      'An independent benchmark that measures how fast transactions get included and what they cost, on Elysium and on HyperEVM, side by side.',
    category: 'Analytics',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: null,
    url: 'https://github.com/brunoamuniz/elysium-vs-hyperevm',
    urlLabel: 'Open',
    x: null,
    contracts: [],
  },
  {
    slug: 'elly',
    name: 'Elly',
    tagline: 'Telegram trading bot',
    description: 'A Telegram bot for trading tokens on Elysium from a chat.',
    category: 'Tools',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/elly.jpg',
    url: 'https://t.me/ellytrade_bot',
    urlLabel: 'Open',
    x: 'https://x.com/Ellytradebot',
    contracts: [],
  },
  {
    slug: 'marketlab',
    name: 'MarketLab',
    tagline: 'Pools with adaptive fees',
    description:
      'Public liquidity pools for Elysium tokens: anyone can open a market for a token, paired with WHYPE or another token, and MarketLab adjusts the swap fees as the price moves. Since Oct 5 you can also open a bonding market for a token. Also a trading workbench for bots and backtests.',
    category: 'DEX',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/marketlab.svg',
    url: 'https://cloud.marketlab.sh',
    urlLabel: 'Trade',
    x: null,
    contracts: [
      {
        address: '0xac139b041074140e98e62b69d1ec1667aab2cade',
        label: 'MarketLab pool factory',
      },
      {
        address: '0xa5b72796e5bf80443dc134f3c8a1cc97dccc39b9',
        label: 'MarketLab wrapped HYPE',
      },
      {
        address: '0x26d4720e52951c23d27fabd3d73ef94829978450',
        label: 'Demo token',
      },
      {
        address: '0x20be1d4ef3b47ce8c5b48a23b152dd1008b74826',
        label: 'Pool 1',
      },
      {
        address: '0xf4caa4ee4cc507ae935c0e5ed698641b687089d3',
        label: 'Pool 2',
      },
      {
        address: '0xd5cb7eb716009ebec076a87261cb748c1a5cc59c',
        label: 'Pool 3',
      },
      {
        address: '0x43bd454e79f7fd63101377817cbd34111fe4a66a',
        label: 'MarketLab bonding market factory',
      },
      {
        address: '0x59675174f1700677e608f86016f1cea764e1abfa',
        label: 'Bonding market 1',
      },
    ],
  },
  {
    slug: 'elysium-ecosystem',
    name: 'Elysium Ecosystem',
    tagline: 'Media & live data',
    description:
      "That's us: an independent community account that explains Elysium in plain words, follows the projects building on it and reads the network's numbers live, block by block.",
    category: 'Analytics',
    status: 'live',
    statusLabel: 'Live',
    logo: '/elysium/logos/elysiumeco.png',
    url: null,
    urlLabel: null,
    x: 'https://x.com/ElysiumEco',
    contracts: [],
  },
  {
    slug: 'hexswap',
    name: 'HexSwap',
    tagline: 'Swap exchange',
    description:
      "A swap exchange deployed on the testnet on Oct 1: a pool factory, a router already used 170+ times, wrapped HYPE and test tokens (USDT, BTC, HEX). We don't know the team yet and there's no site to try it from.",
    category: 'DEX',
    status: 'verifying',
    statusLabel: 'Being verified',
    logo: null,
    url: null,
    urlLabel: null,
    x: null,
    contracts: [
      {
        address: '0x9d02c1d684389d021bf2cf73d1ba7c4652ab1f15',
        label: 'HexSwapRouter',
      },
      {
        address: '0xd7ee2f6a9261a1ca88758a2f07bb5dafa1ec8fe1',
        label: 'HexInteractionBadge',
      },
      {
        address: '0xf04e426488a8679d6888ec9fb4922a98dd2c17b0',
        label: 'Usdt',
      },
      {
        address: '0x1371f36937ac81a1c18ebacc27be95bdfee2c79d',
        label: 'Btc',
      },
      {
        address: '0x26aa352bd4324aa507c924af9edd65b2c7bdc1c2',
        label: 'Hex',
      },
      {
        address: '0x8feda963aa318dc94403a413aa94271588b92d64',
        label: 'HexWrappedNative',
      },
      {
        address: '0xf5269ec7452b71aa79e5ea9d2defbceef76d2c92',
        label: 'HexSwapFactory',
      },
    ],
  },
  {
    slug: 'stockflow',
    name: 'StockFlow',
    tagline: 'Tokenized stocks',
    description:
      "Lets holders of tokenized stocks borrow a dollar stablecoin against them. Their site only mentions Robinhood Chain; tokenized-stock contracts on Elysium have been linked to them, but we haven't confirmed it.",
    category: 'DeFi',
    status: 'verifying',
    statusLabel: 'Being verified',
    logo: '/elysium/logos/stockflow.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/_StockFlow',
    contracts: [],
  },
  {
    slug: 'elysian-fields',
    name: 'Elysian Fields',
    tagline: 'Mines game',
    description:
      "A Mines game on the Elysium testnet. Its contract is one of the most used so far, with a few thousand transactions. We haven't identified the team yet. There's no app or site to try it from yet.",
    category: 'Games',
    status: 'verifying',
    statusLabel: 'Being verified',
    logo: null,
    url: null,
    urlLabel: null,
    x: null,
    contracts: [
      {
        address: '0x09174cce74722f9c62f5eb4c2b0ef7a10101a9af',
        label: 'ElysianFields',
      },
    ],
  },
  {
    slug: 'on-chain-poker',
    name: 'On-chain poker',
    tagline: "No-Limit Hold'em",
    description:
      "Six-seat No-Limit Hold'em where the pot and payouts are handled by the contract, with a card shuffle anyone can check afterwards. No name or website yet, we're trying to find the team. There's no app to play it from yet.",
    category: 'Games',
    status: 'verifying',
    statusLabel: 'Being verified',
    logo: null,
    url: null,
    urlLabel: null,
    x: null,
    contracts: [
      {
        address: '0xd6872cc71475109b0c453acb5f5da7b61536b2cb',
        label: 'Shuffle',
      },
      {
        address: '0x824981f6e8a03ff76d457c125376b69f803dc832',
        label: 'Poker',
      },
      {
        address: '0x0f99e5c4776a18b00e0c7144b71bd3255c7eac61',
        label: 'RakeSplitter',
      },
    ],
  },
  {
    slug: 'montra',
    name: 'Montra',
    tagline: 'Launchpad with a token',
    description:
      'A launchpad coming to Elysium with its own token, which it says will route value from its launches to kHYPE and HYPE. Announced, nothing on the testnet yet.',
    category: 'Launchpad',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/montra.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/MontraXYZ',
    contracts: [],
  },
  {
    slug: 'citadel',
    name: 'Citadel',
    tagline: 'Fair-launch launchpad',
    description:
      "A fair-launch launchpad announced for Elysium. Per its docs, every token starts in a Uniswap V3 pool quoted in HYPE from the first block, with no bonding curve. Its app isn't open yet.",
    category: 'Launchpad',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/citadel.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/citadeldotxyz',
    contracts: [],
  },
  {
    slug: 'pindar',
    name: 'Pindar',
    tagline: 'Funding rates',
    description:
      "Splits Hyperliquid funding rates into a fixed part and a floating part. It says it's building on Elysium; no app or contracts yet.",
    category: 'Derivatives',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/pindar.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/Pindar_finance',
    contracts: [],
  },
  {
    slug: 'hyperflow',
    name: 'HyperFlow',
    tagline: 'Trading aggregator',
    description:
      "A HyperEVM trading app that finds the best swap rate across exchanges and aggregators, and routes bridges. It announced on Sept 28 that it's coming to Elysium.",
    category: 'DEX',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/hyperflow.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/HyperFlow_fun',
    contracts: [],
  },
  {
    slug: 'true-markets',
    name: 'True Markets',
    tagline: 'Tokenized markets',
    description:
      "Tokenized markets, from a team of market veterans from Coinbase's exchange and Circle. It told Elysium's builder chat it plans to build on the testnet.",
    category: 'DEX',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/truemarkets.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/truemarketsco',
    contracts: [],
  },
  {
    slug: 'dawn',
    name: 'Dawn',
    tagline: 'Multichain trading',
    description:
      'Gasless memecoin trading across several chains from one USDC balance, in Telegram. It says it will integrate Elysium from day one of mainnet.',
    category: 'DEX',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/dawn.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/dawndottrade',
    contracts: [],
  },
  {
    slug: 'lutra',
    name: 'Lutra',
    tagline: 'Trader NFTs',
    description:
      "An otter NFT tied to your Hyperliquid trading wallet that changes with every trade you make: its look follows your PnL rank, win rate and best trades. It says it's launching on Elysium; no launch date yet.",
    category: 'NFT',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/lutra.png',
    url: null,
    urlLabel: null,
    x: 'https://x.com/lutra_hl',
    contracts: [],
  },
  {
    slug: 'hyperion',
    name: 'Hyperion',
    tagline: 'Action RPG',
    description:
      "An isometric cyberpunk action RPG that says it's built on Elysium: you raid Vaults, beat the god guarding each one and get out with the loot. There's a whitelist, and we haven't seen its contracts on the testnet yet.",
    category: 'Games',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/hyperion.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/Hyperion_RPG',
    contracts: [],
  },
  {
    slug: 'bound',
    name: 'Bound',
    tagline: 'Price-path trading',
    description:
      "Trades on a price path: you pick a target and a loss level, the payout is fixed when you open, and whichever level the price touches first settles it. Its beta is going live on HyperEVM, and the team says it's keeping an eye on Elysium.",
    category: 'Derivatives',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/bound.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/Bound_Exchange',
    contracts: [],
  },
  {
    slug: 'liquidiction',
    name: 'Liquidiction',
    tagline: 'HIP-4 prediction markets',
    description:
      "Prediction markets on Hyperliquid, built on HIP-4. Its builder said in Elysium's builder chat that they're looking at Elysium to add combos and parlays. Nothing decided yet.",
    category: 'Prediction markets',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/liquidiction.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/LiquidictionHL',
    contracts: [],
  },
  {
    slug: 'outrive',
    name: 'Outrive',
    tagline: 'Social trading',
    description:
      "Prediction-market trading from Telegram and Discord, where friends share calls and can tail or fade them. The team said it's curious what Elysium could add. Nothing decided yet.",
    category: 'Prediction markets',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/outrive.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/outrivexyz',
    contracts: [],
  },
  {
    slug: 'branchpoint',
    name: 'Branchpoint',
    tagline: 'Conditional markets',
    description:
      'Trading, lending and borrowing conditional on future events. The team dropped HyperEVM earlier for performance reasons and says Elysium might be the right home. Still deciding.',
    category: 'Derivatives',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/branchpoint.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/BranchpointXYZ',
    contracts: [],
  },
  {
    slug: 'azalea',
    name: 'Azalea',
    tagline: 'Automated investing',
    description:
      "Builds a portfolio with time-based strategies that execute on HyperCore. The team said it can't wait to build on Elysium, without announcing anything yet.",
    category: 'DeFi',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/azalea.png',
    url: null,
    urlLabel: null,
    x: null,
    contracts: [],
  },
  {
    slug: 'poppay',
    name: 'PopPay',
    tagline: 'Payments',
    description:
      "Quotes, invoices and payments for small businesses in South Africa, with stablecoin payments and dollar savings planned. Its founder said they've been waiting for something like Elysium. No plan announced.",
    category: 'DeFi',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/poppay.png',
    url: null,
    urlLabel: null,
    x: null,
    contracts: [],
  },
  {
    slug: 'perpdexlist',
    name: 'PerpDexList',
    tagline: 'Perp market data',
    description:
      "Funding rates, liquidity and trading costs for perp markets across 46 venues. Its builder said they're waiting for Elysium to launch.",
    category: 'Analytics',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/perpdexlist.png',
    url: null,
    urlLabel: null,
    x: null,
    contracts: [],
  },
  {
    slug: 'infrasingularity',
    name: 'InfraSingularity',
    tagline: 'RPC & validators',
    description:
      'Runs validators and RPC on more than 50 mainnets. It said it wants to explore offering RPC, an indexer and an explorer for Elysium before mainnet.',
    category: 'Infrastructure',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/infrasingularity.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/ISinfra',
    contracts: [],
  },
  {
    slug: 'pantheon',
    name: 'Pantheon',
    tagline: 'Index of Ascend coins',
    description:
      'One token, PNTH, backed by a basket of Ascend coins: buys build the basket and sells burn supply, and stakers earn what the basket buys. Its index vault, staking, basket registry and fee router factory were deployed on the testnet by one wallet and are verified on the explorer.',
    category: 'DeFi',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/pantheon.jpg',
    url: 'https://pantheonindex.com',
    urlLabel: 'Trade',
    x: 'https://x.com/pantheonindex',
    contracts: [
      { address: '0xe636003feb05d0fb8f6016733c3d723446c9f221', label: 'IndexVault' },
      { address: '0x30c88fce1fad545df0fc603287f93f0f94076224', label: 'PantheonStaking' },
      { address: '0xd8cea0015e2c876ab5fa6d9178b46b57d65c6087', label: 'ConstituentRegistry' },
      { address: '0x42b9f24d88ca015cc59e516b272f7a46a87fa35a', label: 'CovenantFactory' },
      { address: '0x31a67d054d34ec18cb23a43b0e3ad1f756aa1500', label: 'Swapper' },
      { address: '0x0eb4a8eb47364be9d18410af2f850db92b807290', label: 'HypePassportRegistry' },
      { address: '0x49c7c3896bfc02fe79eebc13d8c8488ec78e8624', label: 'TestDrip' },
      { address: '0x1c6856862aac444b5ebfc65d2847e52b1c2b7176', label: 'TestDrip' },
    ],
  },
  {
    slug: 'neuriio',
    name: 'Neuriio',
    launchpad: 'Neuriio',
    tagline: 'Tokens for X accounts',
    description:
      'A launchpad where each X account can launch one token, named after its handle; groups of four can launch one together. Tokens sell on a bonding curve, then 206.9M tokens and everything raised go into a V2 pool whose LP tokens are burned. The current pad is priced in test USDC with a 1% fee; earlier versions were priced in HYPE.',
    category: 'Launchpad',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/neuriio.png',
    url: 'https://app.neuriio.xyz/',
    urlLabel: 'Launch',
    x: null,
    contracts: [
      { address: '0x892b08a9b3987516a4ae5ab7d7e4d56642268d76', label: 'NeuriioPad (USDC)' },
      { address: '0x86cc9908c3f3953da13f2a8760afc25b3b6a4776', label: 'NeuriioRouter' },
      { address: '0x63e29d4f1929a9fc59e84c7ee75a50ca6b83709a', label: 'NeuriioStaking' },
      { address: '0x24067f1d414d1bb5fa0fb759d9129d6fed55f031', label: 'NeuriioMinter' },
      { address: '0xd9943d81b72aa55e52580bbb595af797b04d5e59', label: 'NeuriioPad (HYPE)' },
      { address: '0x4a85eca6f3ef4a07d049bd1907debb3e8961acac', label: 'NeuriioSwap' },
      { address: '0x0ab518a961c77911ba9b2635cfe56b9ea54ec73e', label: 'NeuriioPad (HYPE, older)' },
      { address: '0xc54c48e6ef90b53ef49e7bccdac2d5d0578e43a7', label: 'NeuriioPad (HYPE, older)' },
      { address: '0x440c1bd5395a7cbef870c91f600e39aa48433c73', label: 'NeuriioPad (HYPE, older)' },
      { address: '0x3c1b64c5d4ecc1ffc7fa8ab2eb643e86aba8932f', label: 'NeuriioPad (HYPE, older)' },
      { address: '0x6ef011b34d8c08e20a35f4d25cdcc84070e4cb53', label: 'NeuriioPad (HYPE, older)' },
      { address: '0x1cc0838a1344577f5fb4547be8dd72456c3bc97e', label: 'NeuriioPad (HYPE, older)' },
      { address: '0xfd4b6e796456e2f76ddcccf46b9dea4c677cb5e1', label: 'NeuriioPad (HYPE, older)' },
      { address: '0x3a4b7a2604918ce8a4a055d353056f988355b98a', label: 'NeuriioPad (HYPE, older)' },
    ],
  },
  {
    slug: 'tilt',
    name: 'Tilt',
    tagline: 'Provably fair games',
    description:
      "Casino-style games where each round's seed is committed on chain before you play, so the result can be checked afterwards. In beta on the testnet, settling in test USDC; its game contracts and TILT token come from one wallet.",
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/tilt.svg',
    url: 'https://playtilt.gg',
    urlLabel: 'Play',
    x: 'https://x.com/playtilt_gg',
    contracts: [
      { address: '0x832d681b9d42ebcce593626f9184bfa1643afb5f', label: 'Tilt game' },
      { address: '0x736fced7fa447b5c5d883cecbb4b1a0787a7fe9e', label: 'Tilt game' },
      { address: '0x996ae5257e45c59df76b6d507f6bf152b24407bc', label: 'Tilt game' },
      { address: '0xe308caf931e48c05b4bb737d98186aaa3146b266', label: 'Tilt game' },
      { address: '0xd638869a3148ea1fdacdf000b0586f854822b58c', label: 'Tilt game' },
      { address: '0xef5d60f237ad7fbd73d7b1caf591f42f4b73fc7a', label: 'Tilt contract' },
      { address: '0x481fd0cefe8f6b2520bab435143d9983a8b08b10', label: 'TILT token' },
    ],
  },
  {
    slug: 'purrcade',
    name: 'PurrCade',
    tagline: 'Pay-to-play arcade',
    description:
      'Short arcade games played for a small fee, starting with HyPurr Jump. The best score of the last 4 hours takes the crown and earns half of every play while it holds it.',
    category: 'Games',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/purrcade.png',
    url: 'https://purrcade.fun/',
    urlLabel: 'Play',
    x: 'https://x.com/PurrCadeGames',
    contracts: [
      { address: '0xcdbd989842d5014b8a4397c94e9187ccda3cd055', label: 'PurrCade game' },
      { address: '0x9e5a692d9b39f26114ae27b231d668bc21fa6c64', label: 'PurrCade game' },
      { address: '0x89e3774a3329febb0b987b91b2272f40d27e15f4', label: 'PurrCade game' },
      { address: '0xbc43194d019a8527961dfa75e19af093ca42c562', label: 'KNTQ test token' },
    ],
  },
  {
    slug: 'enso',
    name: 'Enso',
    tagline: 'Routing engine',
    description:
      'Turns multi-step on-chain actions into one call for apps. Its EnsoRouter, EnsoShortcuts and DelegateEnsoShortcuts contracts are deployed and verified on the testnet, with no use yet.',
    category: 'Infrastructure',
    status: 'verifying',
    statusLabel: 'Being verified',
    logo: '/elysium/logos/enso.png',
    url: 'https://www.enso.build/',
    urlLabel: 'Open',
    x: 'https://x.com/EnsoBuild',
    contracts: [
      { address: '0xcfbaa9cfce952ca4f4069874ff1df8c05e37a3c7', label: 'EnsoRouter' },
      { address: '0x0d14f7c957bd15f5bec423f9b1b51e122d90fc76', label: 'EnsoShortcuts' },
      { address: '0xa2f4f9c6ec598ca8c633024f8851c79ca5f43e48', label: 'DelegateEnsoShortcuts' },
    ],
  },
  {
    slug: 'alchemy',
    name: 'Alchemy',
    tagline: 'RPC nodes',
    description: 'A major node provider serving the Elysium testnet with RPC endpoints and websockets.',
    category: 'Infrastructure',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/alchemy.svg',
    url: 'https://www.alchemy.com/rpc/elysium-testnet',
    urlLabel: 'Open',
    x: 'https://x.com/Alchemy',
    contracts: [],
  },
  {
    slug: 'quicknode',
    name: 'QuickNode',
    tagline: 'RPC nodes',
    description: 'A major node provider serving the Elysium testnet with RPC endpoints and data tools.',
    category: 'Infrastructure',
    status: 'testnet',
    statusLabel: 'On testnet',
    logo: '/elysium/logos/quicknode.png',
    url: 'https://www.quicknode.com/chains/elysium',
    urlLabel: 'Open',
    x: 'https://x.com/QuickNode',
    contracts: [],
  },
  {
    slug: 'nest',
    name: 'Nest',
    tagline: 've(3,3) MetaDEX',
    description:
      'The HYPE-aligned MetaDEX from HyperEVM, announced for Elysium mainnet. Nothing on the testnet yet.',
    category: 'DEX',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/nest.png',
    url: 'https://www.usenest.xyz/',
    urlLabel: 'Open',
    x: 'https://x.com/nestexchange',
    contracts: [],
  },
  {
    slug: 'speculate',
    name: 'Speculate',
    tagline: 'Prediction markets and packs',
    description:
      'Live prediction markets and a gacha of trading card packs in one wallet app, announced for Elysium mainnet. Nothing on the testnet yet.',
    category: 'Prediction markets',
    status: 'announced',
    statusLabel: 'Announced',
    logo: '/elysium/logos/speculate.png',
    url: 'https://www.speculate.today/',
    urlLabel: 'Open',
    x: 'https://x.com/speculatexyz',
    contracts: [],
  },
  {
    slug: 'orbcast',
    name: 'OrbCast',
    tagline: 'Open-source HIP-4 markets',
    description:
      'Yes or No prediction markets on sports, crypto, stocks and the economy, built on HIP-4. Its builder said Elysium contracts could follow once the HyperCore precompiles are live.',
    category: 'Prediction markets',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/orbcast.png',
    url: 'https://orbcast.xyz',
    urlLabel: 'Open',
    x: null,
    contracts: [],
  },
  {
    slug: 'yochi',
    name: 'Yochi',
    tagline: 'Short-duration prediction games',
    description:
      'Prediction games on short HyperCore price markets, in beta on HyperEVM. Its founder said they are working on an Elysium testnet deployment.',
    category: 'Prediction markets',
    status: 'exploring',
    statusLabel: 'Exploring',
    logo: '/elysium/logos/yochi.jpg',
    url: null,
    urlLabel: null,
    x: 'https://x.com/Yochigg',
    contracts: [],
  },
];
