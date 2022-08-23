import { ethers } from "ethers";
const { BigNumber } = ethers;

export const LOAN_TERM_LENGTH = BigNumber.from("28").mul(86400);
export const OPTION_PURCHASE_FREQ = BigNumber.from("7").mul(86400);
export const LOAN_ALLOCATION_PCT = BigNumber.from("992765");
export const OPTION_ALLOCATION_PCT = BigNumber.from("4222");

export const BORROWERS = {
  WINTERMUTE: "0xA1614eC01d13E04522ED0b085C7a178ED9E99bc9",
  ALAMEDA: "0x0000000000000000000000000000000000000003",
};

export const BORROWER_WEIGHTS = {
  "0xA1614eC01d13E04522ED0b085C7a178ED9E99bc9": 50000,
  "0x0000000000000000000000000000000000000003": 50000,
};

export const OPTION_SELLER = {
  ORBIT: "0x015b37a1E5dAd6259Fd623fbb0137b3cf2b435f3",
};

export const PERFORMANCE_FEE = 15000000; // 15% per year
export const MANAGEMENT_FEE = 0; // 0% per year
