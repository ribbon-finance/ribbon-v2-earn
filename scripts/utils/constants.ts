import { ethers } from "ethers";
const { BigNumber } = ethers;

export const LOAN_TERM_LENGTH = BigNumber.from("28").mul(86400);
export const OPTION_PURCHASE_FREQ = BigNumber.from("7").mul(86400);
export const LOAN_ALLOCATION_PCT = BigNumber.from("9900");
export const OPTION_ALLOCATION_PCT = BigNumber.from("100");

export const BORROWERS = {
  GENESIS: "0x0000000000000000000000000000000000000001",
  WINTERMUTE: "0x0000000000000000000000000000000000000001",
};

export const BORROWER_WEIGHTS = {
  "0x0000000000000000000000000000000000000001": 50000,
};

export const OPTION_SELLER = {
  ORBIT: "0x0000000000000000000000000000000000000001",
};

export const PERFORMANCE_FEE = 10000000;
export const MANAGEMENT_FEE = 2000000; // 2% per year. 2 * 10**6. Should result in 38356 per week.
