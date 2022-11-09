import { ethers } from "ethers";
const { BigNumber } = ethers;

export const LOAN_TERM_LENGTH = {
  USDC: BigNumber.from("28").mul(86400),
  stETH: BigNumber.from("7").mul(86400),
};

export const OPTION_PURCHASE_FREQ = {
  USDC: BigNumber.from("7").mul(86400),
  stETH: BigNumber.from("7").mul(86400),
};

export const LOAN_ALLOCATION_PCT = {
  USDC: BigNumber.from("992765"),
  stETH: BigNumber.from("0"),
};

export const OPTION_ALLOCATION_PCT = {
  USDC: BigNumber.from("4222"),
  stETH: BigNumber.from("4222"),
};

export const BORROWERS = {
  WINTERMUTE: "0xA1614eC01d13E04522ED0b085C7a178ED9E99bc9",
  FOLKVANG: "0x44C8e19Bd59A8EA895fFf60DBB4e762028f2fb71",
};

export const BORROWER_WEIGHTS = {
  "0xA1614eC01d13E04522ED0b085C7a178ED9E99bc9": 50000,
  "0x44C8e19Bd59A8EA895fFf60DBB4e762028f2fb71": 50000,
};

export const OPTION_SELLER = {
  ORBIT: "0x015b37a1E5dAd6259Fd623fbb0137b3cf2b435f3",
};

export const PERFORMANCE_FEE = 15000000; // 15% per year
export const MANAGEMENT_FEE = 0; // 0% per year
