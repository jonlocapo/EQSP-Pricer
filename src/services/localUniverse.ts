/**
 * A built-in list of the underlyings a structured products desk actually uses,
 * searchable by NAME with no network at all.
 *
 * WHY: ticker search reaches Yahoo through public CORS relays, which
 * rate-limit and go down. When they do, the only way to pick an underlying was
 * to know its exact Yahoo symbol, which nobody keeps in their head for a Swiss
 * or a Japanese line. So a relay outage stopped the user naming a stock, even
 * though pricing itself needs no lookup once the symbol is known.
 *
 * This list is a CONVENIENCE, not the source of truth. The network search stays
 * authoritative and its results win on merge, because they carry the live name,
 * exchange and listing currency. This list only has to be right about the
 * SYMBOL. Everything else the app needs is fetched from the symbol.
 *
 * A wrong symbol here cannot silently misprice: the spot fetch runs against the
 * picked symbol, and the dropdown shows the name and exchange, so a bad entry
 * is visible before anything is priced.
 *
 * Coverage is deliberately the structured products universe, not the whole
 * market: EURO STOXX 50 and its national indices, the large US names, the main
 * indices, and the ETFs used as index proxies. Anything outside it still needs
 * the network search, or an exact symbol.
 */
import type { SymbolMatch } from './symbolSearch';

interface UniverseEntry extends SymbolMatch {
  /** Extra spellings that should find this entry: short forms, former names,
   * index codes people say out loud ("SX5E", "SPX"). */
  aliases?: string[];
}

/**
 * Yahoo suffixes used below: `.DE` XETRA, `.PA` Paris, `.AS` Amsterdam,
 * `.SW` SIX Swiss, `.MC` Madrid, `.MI` Milan, `.L` London, `.BR` Brussels,
 * `.ST` Stockholm, `.CO` Copenhagen, `.OL` Oslo, `.HE` Helsinki, `.VI` Vienna,
 * `.T` Tokyo, `.HK` Hong Kong. US lines carry no suffix.
 */
export const LOCAL_UNIVERSE: UniverseEntry[] = [
  // ---- Indices -----------------------------------------------------------
  { symbol: '^STOXX50E', name: 'EURO STOXX 50', exchange: 'STOXX', quoteType: 'INDEX', currency: 'EUR', aliases: ['sx5e', 'estoxx', 'eurostoxx', 'stoxx 50'] },
  { symbol: '^STOXX', name: 'STOXX Europe 600', exchange: 'STOXX', quoteType: 'INDEX', currency: 'EUR', aliases: ['sxxp', 'stoxx 600', 'europe 600'] },
  { symbol: '^GDAXI', name: 'DAX 40', exchange: 'XETRA', quoteType: 'INDEX', currency: 'EUR', aliases: ['dax'] },
  { symbol: '^FCHI', name: 'CAC 40', exchange: 'Paris', quoteType: 'INDEX', currency: 'EUR', aliases: ['cac'] },
  { symbol: '^SSMI', name: 'Swiss Market Index', exchange: 'SIX', quoteType: 'INDEX', currency: 'CHF', aliases: ['smi'] },
  { symbol: '^FTSE', name: 'FTSE 100', exchange: 'London', quoteType: 'INDEX', currency: 'GBP', aliases: ['ukx', 'footsie'] },
  { symbol: '^AEX', name: 'AEX', exchange: 'Amsterdam', quoteType: 'INDEX', currency: 'EUR' },
  { symbol: '^IBEX', name: 'IBEX 35', exchange: 'Madrid', quoteType: 'INDEX', currency: 'EUR' },
  { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', exchange: 'Milan', quoteType: 'INDEX', currency: 'EUR', aliases: ['mib'] },
  { symbol: '^GSPC', name: 'S&P 500', exchange: 'CBOE', quoteType: 'INDEX', currency: 'USD', aliases: ['spx', 'sp500', 's and p'] },
  { symbol: '^NDX', name: 'Nasdaq 100', exchange: 'Nasdaq', quoteType: 'INDEX', currency: 'USD', aliases: ['ndx', 'nasdaq100'] },
  { symbol: '^IXIC', name: 'Nasdaq Composite', exchange: 'Nasdaq', quoteType: 'INDEX', currency: 'USD' },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average', exchange: 'NYSE', quoteType: 'INDEX', currency: 'USD', aliases: ['dow'] },
  { symbol: '^RUT', name: 'Russell 2000', exchange: 'NYSE', quoteType: 'INDEX', currency: 'USD' },
  { symbol: '^N225', name: 'Nikkei 225', exchange: 'Tokyo', quoteType: 'INDEX', currency: 'JPY', aliases: ['nikkei', 'nky'] },
  { symbol: '^HSI', name: 'Hang Seng Index', exchange: 'Hong Kong', quoteType: 'INDEX', currency: 'HKD', aliases: ['hsi'] },
  { symbol: '^KS11', name: 'KOSPI', exchange: 'Korea', quoteType: 'INDEX', currency: 'KRW' },
  { symbol: '^VIX', name: 'CBOE Volatility Index', exchange: 'CBOE', quoteType: 'INDEX', currency: 'USD', aliases: ['vix'] },

  // ---- Index ETFs, used as proxies --------------------------------------
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'Nasdaq', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'FEZ', name: 'SPDR EURO STOXX 50 ETF', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'EWJ', name: 'iShares MSCI Japan ETF', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'EEM', name: 'iShares MSCI Emerging Markets ETF', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'GLD', name: 'SPDR Gold Shares', exchange: 'NYSE Arca', quoteType: 'ETF', currency: 'USD' },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', exchange: 'Nasdaq', quoteType: 'ETF', currency: 'USD' },

  // ---- Germany -----------------------------------------------------------
  { symbol: 'SAP.DE', name: 'SAP SE', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'SIE.DE', name: 'Siemens AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ALV.DE', name: 'Allianz SE', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'MUV2.DE', name: 'Munich Re', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['munich re', 'muenchener rueck'] },
  { symbol: 'BAS.DE', name: 'BASF SE', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'BAYN.DE', name: 'Bayer AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'BMW.DE', name: 'Bayerische Motoren Werke AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['bmw'] },
  { symbol: 'MBG.DE', name: 'Mercedes-Benz Group AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['mercedes', 'daimler'] },
  { symbol: 'VOW3.DE', name: 'Volkswagen AG Pref', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['volkswagen', 'vw'] },
  { symbol: 'RHM.DE', name: 'Rheinmetall AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'DTE.DE', name: 'Deutsche Telekom AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'DBK.DE', name: 'Deutsche Bank AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'IFX.DE', name: 'Infineon Technologies AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ADS.DE', name: 'adidas AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'DPW.DE', name: 'DHL Group', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['deutsche post', 'dhl'] },
  { symbol: 'RWE.DE', name: 'RWE AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'EOAN.DE', name: 'E.ON SE', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR', aliases: ['eon'] },
  { symbol: 'HEI.DE', name: 'Heidelberg Materials AG', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'MRK.DE', name: 'Merck KGaA', exchange: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },

  // ---- France ------------------------------------------------------------
  { symbol: 'MC.PA', name: 'LVMH', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['lvmh', 'louis vuitton'] },
  { symbol: 'OR.PA', name: "L'Oreal", exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['loreal'] },
  { symbol: 'TTE.PA', name: 'TotalEnergies SE', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['total'] },
  { symbol: 'SAN.PA', name: 'Sanofi', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'AIR.PA', name: 'Airbus SE', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'BNP.PA', name: 'BNP Paribas', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['bnpp'] },
  { symbol: 'SU.PA', name: 'Schneider Electric SE', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'AI.PA', name: 'Air Liquide', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'RMS.PA', name: 'Hermes International', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'KER.PA', name: 'Kering', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['gucci'] },
  { symbol: 'CS.PA', name: 'AXA SA', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'DG.PA', name: 'Vinci SA', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'SGO.PA', name: 'Saint-Gobain', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'EL.PA', name: 'EssilorLuxottica', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'GLE.PA', name: 'Societe Generale', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['socgen'] },
  { symbol: 'ACA.PA', name: 'Credit Agricole', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ORA.PA', name: 'Orange SA', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'CAP.PA', name: 'Capgemini SE', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ENGI.PA', name: 'Engie SA', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'STLAP.PA', name: 'Stellantis NV', exchange: 'Paris', quoteType: 'EQUITY', currency: 'EUR', aliases: ['stellantis'] },

  // ---- Netherlands / Belgium --------------------------------------------
  { symbol: 'ASML.AS', name: 'ASML Holding NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'INGA.AS', name: 'ING Groep NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'PRX.AS', name: 'Prosus NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ADYEN.AS', name: 'Adyen NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'AD.AS', name: 'Ahold Delhaize', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'PHIA.AS', name: 'Koninklijke Philips NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR', aliases: ['philips'] },
  { symbol: 'HEIA.AS', name: 'Heineken NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'WKL.AS', name: 'Wolters Kluwer NV', exchange: 'Amsterdam', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ABI.BR', name: 'Anheuser-Busch InBev', exchange: 'Brussels', quoteType: 'EQUITY', currency: 'EUR', aliases: ['ab inbev', 'budweiser'] },

  // ---- Switzerland -------------------------------------------------------
  { symbol: 'NESN.SW', name: 'Nestle SA', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF', aliases: ['nestle'] },
  { symbol: 'ROG.SW', name: 'Roche Holding AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'NOVN.SW', name: 'Novartis AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'UBSG.SW', name: 'UBS Group AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'ZURN.SW', name: 'Zurich Insurance Group', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'ABBN.SW', name: 'ABB Ltd', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'CFR.SW', name: 'Cie Financiere Richemont', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF', aliases: ['richemont', 'cartier'] },
  { symbol: 'LONN.SW', name: 'Lonza Group AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'SIKA.SW', name: 'Sika AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'GIVN.SW', name: 'Givaudan SA', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'SREN.SW', name: 'Swiss Re AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },
  { symbol: 'HOLN.SW', name: 'Holcim AG', exchange: 'SIX', quoteType: 'EQUITY', currency: 'CHF' },

  // ---- Spain / Italy -----------------------------------------------------
  { symbol: 'SAN.MC', name: 'Banco Santander SA', exchange: 'Madrid', quoteType: 'EQUITY', currency: 'EUR', aliases: ['santander'] },
  { symbol: 'BBVA.MC', name: 'Banco Bilbao Vizcaya Argentaria', exchange: 'Madrid', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ITX.MC', name: 'Industria de Diseno Textil', exchange: 'Madrid', quoteType: 'EQUITY', currency: 'EUR', aliases: ['inditex', 'zara'] },
  { symbol: 'IBE.MC', name: 'Iberdrola SA', exchange: 'Madrid', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'TEF.MC', name: 'Telefonica SA', exchange: 'Madrid', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ENI.MI', name: 'Eni SpA', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ISP.MI', name: 'Intesa Sanpaolo', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'UCG.MI', name: 'UniCredit SpA', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'ENEL.MI', name: 'Enel SpA', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR' },
  { symbol: 'RACE.MI', name: 'Ferrari NV', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR', aliases: ['ferrari'] },
  { symbol: 'G.MI', name: 'Assicurazioni Generali', exchange: 'Milan', quoteType: 'EQUITY', currency: 'EUR', aliases: ['generali'] },

  // ---- United Kingdom ----------------------------------------------------
  { symbol: 'AZN.L', name: 'AstraZeneca PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'SHEL.L', name: 'Shell PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'HSBA.L', name: 'HSBC Holdings PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP', aliases: ['hsbc'] },
  { symbol: 'ULVR.L', name: 'Unilever PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'BP.L', name: 'BP PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'GSK.L', name: 'GSK PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP', aliases: ['glaxo'] },
  { symbol: 'RIO.L', name: 'Rio Tinto PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'BATS.L', name: 'British American Tobacco', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'BARC.L', name: 'Barclays PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'LLOY.L', name: 'Lloyds Banking Group', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'VOD.L', name: 'Vodafone Group PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'DGE.L', name: 'Diageo PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },
  { symbol: 'GLEN.L', name: 'Glencore PLC', exchange: 'London', quoteType: 'EQUITY', currency: 'GBP' },

  // ---- Nordics / Austria -------------------------------------------------
  { symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S', exchange: 'Copenhagen', quoteType: 'EQUITY', currency: 'DKK', aliases: ['novo nordisk'] },
  { symbol: 'ATCO-A.ST', name: 'Atlas Copco AB', exchange: 'Stockholm', quoteType: 'EQUITY', currency: 'SEK' },
  { symbol: 'VOLV-B.ST', name: 'Volvo AB', exchange: 'Stockholm', quoteType: 'EQUITY', currency: 'SEK' },
  { symbol: 'ERIC-B.ST', name: 'Telefonaktiebolaget LM Ericsson', exchange: 'Stockholm', quoteType: 'EQUITY', currency: 'SEK', aliases: ['ericsson'] },
  { symbol: 'EQNR.OL', name: 'Equinor ASA', exchange: 'Oslo', quoteType: 'EQUITY', currency: 'NOK' },
  { symbol: 'NOKIA.HE', name: 'Nokia Oyj', exchange: 'Helsinki', quoteType: 'EQUITY', currency: 'EUR' },

  // ---- United States -----------------------------------------------------
  { symbol: 'AAPL', name: 'Apple Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'AMZN', name: 'Amazon.com Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'GOOGL', name: 'Alphabet Inc Class A', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD', aliases: ['google'] },
  { symbol: 'META', name: 'Meta Platforms Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD', aliases: ['facebook'] },
  { symbol: 'TSLA', name: 'Tesla Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc Class B', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['berkshire'] },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['jp morgan'] },
  { symbol: 'GS', name: 'Goldman Sachs Group Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['goldman'] },
  { symbol: 'MS', name: 'Morgan Stanley', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'BAC', name: 'Bank of America Corporation', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'C', name: 'Citigroup Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['citi'] },
  { symbol: 'WFC', name: 'Wells Fargo & Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'V', name: 'Visa Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'MA', name: 'Mastercard Incorporated', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['exxon'] },
  { symbol: 'CVX', name: 'Chevron Corporation', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'LLY', name: 'Eli Lilly and Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'PFE', name: 'Pfizer Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'MRK', name: 'Merck & Co Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'ABBV', name: 'AbbVie Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'UNH', name: 'UnitedHealth Group Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'WMT', name: 'Walmart Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'PG', name: 'Procter & Gamble Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'KO', name: 'Coca-Cola Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['coca cola', 'coke'] },
  { symbol: 'PEP', name: 'PepsiCo Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD', aliases: ['pepsi'] },
  { symbol: 'MCD', name: "McDonald's Corporation", exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['mcdonalds'] },
  { symbol: 'NKE', name: 'NIKE Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['nike'] },
  { symbol: 'HD', name: 'Home Depot Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'DIS', name: 'Walt Disney Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['disney'] },
  { symbol: 'NFLX', name: 'Netflix Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'INTC', name: 'Intel Corporation', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'AVGO', name: 'Broadcom Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'ORCL', name: 'Oracle Corporation', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'CRM', name: 'Salesforce Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'ADBE', name: 'Adobe Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'CSCO', name: 'Cisco Systems Inc', exchange: 'Nasdaq', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'BA', name: 'Boeing Company', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD', aliases: ['boeing'] },
  { symbol: 'CAT', name: 'Caterpillar Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'T', name: 'AT&T Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },
  { symbol: 'VZ', name: 'Verizon Communications Inc', exchange: 'NYSE', quoteType: 'EQUITY', currency: 'USD' },

  // ---- Japan / Hong Kong -------------------------------------------------
  { symbol: '7203.T', name: 'Toyota Motor Corporation', exchange: 'Tokyo', quoteType: 'EQUITY', currency: 'JPY', aliases: ['toyota'] },
  { symbol: '6758.T', name: 'Sony Group Corporation', exchange: 'Tokyo', quoteType: 'EQUITY', currency: 'JPY', aliases: ['sony'] },
  { symbol: '9984.T', name: 'SoftBank Group Corp', exchange: 'Tokyo', quoteType: 'EQUITY', currency: 'JPY', aliases: ['softbank'] },
  { symbol: '6861.T', name: 'Keyence Corporation', exchange: 'Tokyo', quoteType: 'EQUITY', currency: 'JPY' },
  { symbol: '8306.T', name: 'Mitsubishi UFJ Financial Group', exchange: 'Tokyo', quoteType: 'EQUITY', currency: 'JPY', aliases: ['mufg'] },
  { symbol: '0700.HK', name: 'Tencent Holdings Ltd', exchange: 'Hong Kong', quoteType: 'EQUITY', currency: 'HKD', aliases: ['tencent'] },
  { symbol: '9988.HK', name: 'Alibaba Group Holding Ltd', exchange: 'Hong Kong', quoteType: 'EQUITY', currency: 'HKD', aliases: ['alibaba'] },
  { symbol: '1299.HK', name: 'AIA Group Ltd', exchange: 'Hong Kong', quoteType: 'EQUITY', currency: 'HKD' },
];

/** Lowercases, strips accents and reduces punctuation to spaces, so "L'Oreal",
 * "Nestle" and "loreal" all compare the same way. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9^.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pre-normalised haystacks, built once. */
const INDEX = LOCAL_UNIVERSE.map((e) => ({
  entry: e,
  symbol: normalize(e.symbol),
  /** Symbol without its exchange suffix, so "rhm" finds "RHM.DE". */
  root: normalize(e.symbol).replace(/\.[a-z]+$/, '').replace(/^\^/, ''),
  name: normalize(e.name),
  words: normalize(e.name).split(' '),
  aliases: (e.aliases ?? []).map(normalize),
}));

/**
 * Matches by symbol or by name, best first.
 *
 * Ranking, lowest score first: an exact symbol beats a symbol prefix, which
 * beats a name that starts with the query, which beats a match on a later word
 * of the name. A desk typing "san" wants Santander and Sanofi at the top, not
 * a name with "san" buried in the middle.
 */
export function searchLocalUniverse(query: string, limit = 8): SymbolMatch[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { score: number; entry: SymbolMatch }[] = [];

  for (const row of INDEX) {
    let score = Infinity;
    if (row.symbol === q || row.root === q) score = 0;
    else if (row.aliases.includes(q)) score = 1;
    else if (row.symbol.startsWith(q) || row.root.startsWith(q)) score = 2;
    else if (row.name.startsWith(q)) score = 3;
    else if (row.aliases.some((a) => a.startsWith(q))) score = 4;
    else if (row.words.some((w) => w.startsWith(q))) score = 5;
    else if (row.name.includes(q)) score = 6;
    if (score < Infinity) scored.push({ score, entry: stripAliases(row.entry) });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.symbol.localeCompare(b.entry.symbol));
  return scored.slice(0, limit).map((s) => s.entry);
}

/** The universe rows carry `aliases`, which is a search aid and not part of a
 * match. Drop it so a local result and a network result have the same shape. */
function stripAliases(e: UniverseEntry): SymbolMatch {
  return {
    symbol: e.symbol,
    name: e.name,
    exchange: e.exchange,
    quoteType: e.quoteType,
    currency: e.currency,
  };
}
