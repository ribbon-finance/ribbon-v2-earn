import { ethers } from "ethers";
const { BigNumber } = ethers;

export const LOAN_TERM_LENGTH = {
  USDC: BigNumber.from("7").mul(86400),
  STETH: BigNumber.from("7").mul(86400),
};

export const OPTION_PURCHASE_FREQ = {
  USDC: BigNumber.from("7").mul(86400),
  STETH: BigNumber.from("7").mul(86400),
};

export const LOAN_ALLOCATION_PCT = {
  USDC: BigNumber.from("992765"),
  STETH: BigNumber.from("0"),
};

export const OPTION_ALLOCATION_PCT = {
  USDC: BigNumber.from("4222"),
  STETH: BigNumber.from("4222"),
};

export const BORROWERS = {
  BIB01: "0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5",
};

export const BORROWER_SWEEPER_ADDRESSES = {
  BIB01: { issue: "0xdfb5a92cbd8ad817566bdc8abeaf8be0e4387472", redeem: "0x30f46f481a9e1576eb79114029a84bc0687174b0" },
};

export const BORROWER_WEIGHTS = {
  "0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5": 100000,
};

export const OPTION_SELLER = {
  ORBIT: "0x015b37a1E5dAd6259Fd623fbb0137b3cf2b435f3",
  ORBIT_TWO: "0x54c39a7FA0D8CAa251Bad55c7abeFA43BC8ba749",
};

export const PRODUCT_ORACLE = {
  BIB01: "0x788D911ae7c95121A89A0f0306db65D87422E1de",
};

export const MM_SPREAD = {
  BIB01: 0, // 0 bps
};

export const PROVIDER_SPREAD = {
  BIB01: 4000, // 4000 bps
};

export const MIN_PROVIDER_SWAP = BigNumber.from("7500").mul(BigNumber.from("10").pow("6"));
export const SET_PRODUCT_TIMELOCK = 604800; // 7 days
export const PERFORMANCE_FEE = 15000000; // 15% per year
export const MANAGEMENT_FEE = 0; // 0% per year
