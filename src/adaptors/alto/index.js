const { request, gql } = require('graphql-request');
const sdk = require('@defillama/sdk');
const axios = require('axios');
const { getAddress } = require('ethers').utils;

const SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cll6foogb576z38zr00ybh2hw/subgraphs/alto-lending-mainnet/0.0.4/gn';

const CHAIN = 'ethereum';
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const WAD = 1e18;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const irmAbi =
  'function updateInterestRateView(uint256 totalSupply, uint256 totalBorrowed) external view returns (uint256, uint256)';

const balanceOfAbi =
  'function balanceOf(address account) view returns (uint256)';

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
      liquidationThreshold
      irm
      totalSupply
      totalBorrow
      inputToken {
        id
        symbol
        decimals
        lastPriceUSD
      }
      borrowedToken {
        id
        symbol
        decimals
        lastPriceUSD
      }
      totalValueLockedUSD
      totalDepositBalanceUSD
      totalBorrowBalanceUSD
    }
  }
`;

const formatChain = (chain) =>
  chain.charAt(0).toUpperCase() + chain.slice(1);

const getPrices = async (addresses, chain) => {
  const priceKeys = chain
    ? addresses.map((address) => `${chain}:${address}`)
    : addresses;
  const prices = (
    await axios.get(
      `https://coins.llama.fi/prices/current/${priceKeys.join(',').toLowerCase()}`
    )
  ).data.coins;

  return Object.entries(prices).reduce(
    (acc, [address, price]) => ({
      ...acc,
      [address.split(':')[1].toLowerCase()]: price.price,
    }),
    {}
  );
};

const aprToApy = (apr, compoundFrequency = 365) => {
  if (!apr || !isFinite(apr)) return 0;
  return (
    (Math.pow(1 + (apr * 0.01) / compoundFrequency, compoundFrequency) - 1) *
    100
  );
};

const fetchLiveRates = async (markets) => {
  const rates = new Map();
  const irmCalls = [];
  const marketIndex = [];

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const marketId = market.id.toLowerCase();
    const irmAddr = market.irm;
    const totalSupplyBig = market.totalSupply || '0';
    const totalBorrowBig = market.totalBorrow || '0';

    if (!irmAddr || irmAddr === ZERO_ADDRESS || BigInt(totalBorrowBig) === 0n) {
      rates.set(marketId, { borrowApr: 0, supplyApr: 0 });
      continue;
    }

    irmCalls.push({ target: irmAddr, params: [totalSupplyBig, totalBorrowBig] });
    marketIndex.push({ marketId, totalSupplyBig, totalBorrowBig });
  }

  if (irmCalls.length === 0) return rates;

  const result = await sdk.api.abi.multiCall({
    calls: irmCalls,
    abi: irmAbi,
    chain: CHAIN,
    permitFailure: true,
  });

  for (let j = 0; j < marketIndex.length; j++) {
    const { marketId, totalSupplyBig, totalBorrowBig } = marketIndex[j];
    const output = result.output[j];
    if (!output?.output) continue;

    const [, borrowRatePerSecond] = output.output;
    const borrowApr = (Number(borrowRatePerSecond) / WAD) * SECONDS_PER_YEAR * 100;

    const totalSupplyNum = Number(totalSupplyBig);
    const totalBorrowNum = Number(totalBorrowBig);
    const utilization = totalSupplyNum > 0 ? totalBorrowNum / totalSupplyNum : 0;
    const supplyApr = borrowApr * utilization;

    rates.set(marketId, { borrowApr, supplyApr });
  }

  return rates;
};

const apy = async () => {
  let allMarkets = [];
  let skip = 0;

  while (true) {
    const data = await request(SUBGRAPH_URL, marketsQuery, { skip });
    const markets = data.markets || [];
    if (!markets.length) break;
    allMarkets = allMarkets.concat(markets);
    skip += 100;
  }

  const liveRates = await fetchLiveRates(allMarkets);

  const tokenAddresses = [
    ...new Set(
      allMarkets
        .flatMap((m) => [m.inputToken?.id, m.borrowedToken?.id])
        .filter(Boolean)
        .map((a) => a.toLowerCase())
    ),
  ];
  const prices = await getPrices(tokenAddresses, CHAIN);

  const collateralBalances = await sdk.api.abi
    .multiCall({
      calls: allMarkets.map((m) => ({
        target: m.inputToken.id,
        params: [m.id],
      })),
      abi: balanceOfAbi,
      chain: CHAIN,
      permitFailure: true,
    })
    .then((r) => r.output.map((o) => o.output ?? '0'));

  const pools = allMarkets
    .map((market, idx) => {
      if (!market.inputToken?.symbol) return null;

      const marketId = market.id.toLowerCase();
      const onChainRate = liveRates.get(marketId);

      const supplyApr = onChainRate?.supplyApr ?? 0;
      const borrowApr = onChainRate?.borrowApr ?? 0;

      const collateralAddr = market.inputToken.id.toLowerCase();
      const borrowAddr = market.borrowedToken?.id?.toLowerCase();
      const collateralPrice = prices[collateralAddr] || 0;
      const collateralDecimals = Number(market.inputToken.decimals);
      const borrowPrice = prices[borrowAddr] || 0;
      const borrowDecimals = Number(market.borrowedToken?.decimals ?? 18);

      const tvlUsd =
        (Number(collateralBalances[idx] ?? 0) * collateralPrice) /
        Math.pow(10, collateralDecimals);

      const totalBorrowUsd =
        (Number(market.totalBorrow ?? 0) * borrowPrice) /
        Math.pow(10, borrowDecimals);

      const debtCeilingUsd = Math.max(0, tvlUsd - totalBorrowUsd);

      let ltv = Number(market.maximumLTV);
      if (ltv > 1) ltv = ltv / 1e18;

      const symbol = market.inputToken.symbol;
      const borrowedSymbol = market.borrowedToken?.symbol;
      const isMintMarket = market.isMintMarket === true;

      return {
        pool: `alto-${marketId}-${CHAIN}`,
        chain: formatChain(CHAIN),
        project: 'alto',
        symbol,
        apyBase: aprToApy(supplyApr),
        apyBaseBorrow: aprToApy(borrowApr),
        tvlUsd,
        totalSupplyUsd: tvlUsd,
        totalBorrowUsd,
        debtCeilingUsd,
        underlyingTokens: [collateralAddr],
        ltv,
        ...(isMintMarket && borrowedSymbol && { mintedCoin: borrowedSymbol }),
        url: `https://app.alto.money/${isMintMarket ? 'mint' : 'borrow'}/1:${getAddress(market.id)}`,
      };
    })
    .filter(Boolean);

  return pools;
};

module.exports = {
  timetravel: false,
  apy,
};
