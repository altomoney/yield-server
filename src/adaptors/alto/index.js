const { request, gql } = require('graphql-request');
const sdk = require('@defillama/sdk');
const utils = require('../utils');
const { getAddress } = require('ethers').utils;

const SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cll6foogb576z38zr00ybh2hw/subgraphs/alto-lending-mainnet/0.0.4/gn';

const CHAIN = 'ethereum';
const PROJECT = 'alto';
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const IRM_ABI =
  'function updateInterestRateView(uint256 totalSupply, uint256 totalBorrowed) external view returns (uint256, uint256)';

const marketsQuery = gql`
  query GetMarkets($skip: Int!) {
    markets(
      first: 100
      skip: $skip
      where: { isActive: true }
      orderBy: totalValueLockedUSD
      orderDirection: desc
    ) {
      id
      name
      isActive
      canBorrowFrom
      isMintMarket
      maximumLTV
      irm
      totalSupply
      totalBorrow
      inputToken {
        id
        symbol
        decimals
      }
      borrowedToken {
        id
        symbol
        decimals
      }
    }
  }
`;

const fetchAllMarkets = async () => {
  const markets = [];
  let skip = 0;
  while (true) {
    const { markets: page } = await request(SUBGRAPH_URL, marketsQuery, {
      skip,
    });
    if (!page?.length) break;
    markets.push(...page);
    if (page.length < 100) break;
    skip += 100;
  }
  return markets;
};

const fetchLiveRates = async (markets) => {
  const rates = new Map();
  const calls = [];
  const callIndex = [];

  for (const market of markets) {
    const id = market.id.toLowerCase();
    const { irm, totalSupply = '0', totalBorrow = '0' } = market;

    if (!irm || irm === ZERO_ADDRESS || BigInt(totalBorrow) === 0n) {
      rates.set(id, { borrowApr: 0, supplyApr: 0 });
      continue;
    }

    calls.push({ target: irm, params: [totalSupply, totalBorrow] });
    callIndex.push({ id, totalSupply, totalBorrow });
  }

  if (!calls.length) return rates;

  const { output } = await sdk.api.abi.multiCall({
    calls,
    abi: IRM_ABI,
    chain: CHAIN,
    permitFailure: true,
  });

  for (let i = 0; i < callIndex.length; i++) {
    const { id, totalSupply, totalBorrow } = callIndex[i];
    const result = output[i]?.output;
    if (!result) continue;

    const [, borrowRatePerSecond] = result;
    const borrowApr =
      (Number(borrowRatePerSecond) / 1e18) * SECONDS_PER_YEAR * 100;

    const utilization =
      Number(totalSupply) > 0
        ? Number(totalBorrow) / Number(totalSupply)
        : 0;
    const supplyApr = borrowApr * utilization;

    rates.set(id, { borrowApr, supplyApr });
  }

  return rates;
};

const apy = async () => {
  const markets = await fetchAllMarkets();
  if (!markets.length) return [];

  const tokenAddresses = [
    ...new Set(
      markets
        .flatMap((m) => [m.inputToken?.id, m.borrowedToken?.id])
        .filter(Boolean)
        .map((a) => a.toLowerCase())
    ),
  ];

  const [liveRates, collateralBalances, { pricesByAddress: prices }] =
    await Promise.all([
      fetchLiveRates(markets),
      sdk.api.abi
        .multiCall({
          calls: markets.map((m) => ({
            target: m.inputToken.id,
            params: [m.id],
          })),
          abi: 'erc20:balanceOf',
          chain: CHAIN,
          permitFailure: true,
        })
        .then((r) => r.output.map((o) => o.output ?? '0')),
      utils.getPrices(tokenAddresses, CHAIN),
    ]);

  return markets
    .map((market, i) => {
      if (!market.inputToken?.symbol) return null;

      const id = market.id.toLowerCase();
      const rates = liveRates.get(id) ?? { borrowApr: 0, supplyApr: 0 };

      const collateralAddr = market.inputToken.id.toLowerCase();
      const borrowAddr = market.borrowedToken?.id?.toLowerCase();
      const collateralPrice = prices[collateralAddr] ?? 0;
      const borrowPrice = prices[borrowAddr] ?? 0;

      if (!collateralPrice) return null;

      const collateralDecimals = Number(market.inputToken.decimals);
      const borrowDecimals = Number(market.borrowedToken?.decimals ?? 18);

      const totalSupplyUsd =
        (Number(collateralBalances[i]) / 10 ** collateralDecimals) *
        collateralPrice;

      const totalBorrowUsd =
        (Number(market.totalBorrow ?? 0) / 10 ** borrowDecimals) * borrowPrice;

      const tvlUsd = Math.max(0, totalSupplyUsd - totalBorrowUsd);

      let ltv = Number(market.maximumLTV);
      if (ltv > 1) ltv = ltv / 1e18;

      const isMintMarket = market.isMintMarket === true;
      const borrowedSymbol = market.borrowedToken?.symbol;
      const marketAddr = getAddress(market.id);

      return {
        pool: `${id}-${CHAIN}`,
        chain: utils.formatChain(CHAIN),
        project: PROJECT,
        symbol: utils.formatSymbol(market.inputToken.symbol),
        tvlUsd,
        totalSupplyUsd,
        totalBorrowUsd,
        apyBase: utils.aprToApy(rates.supplyApr),
        apyBaseBorrow: utils.aprToApy(rates.borrowApr),
        underlyingTokens: [collateralAddr],
        ltv,
        borrowable: market.canBorrowFrom === true,
        ...(isMintMarket && borrowedSymbol
          ? { mintedCoin: borrowedSymbol }
          : {}),
        url: `https://app.alto.money/${isMintMarket ? 'mint' : 'borrow'}/1:${marketAddr}`,
      };
    })
    .filter(Boolean)
    .filter(utils.keepFinite);
};

module.exports = {
  timetravel: false,
  apy,
};