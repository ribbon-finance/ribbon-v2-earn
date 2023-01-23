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
  WINTERMUTE: "0x0Aea75705Be8281f4c24c3E954D1F8b1D0f8044C",
  FOLKVANG: "0x3CD0ecf1552D135b8Da61c7f44cEFE93485c616d",
};

export const BORROWER_WEIGHTS = {
  "0x0Aea75705Be8281f4c24c3E954D1F8b1D0f8044C": 50000,
  "0x3CD0ecf1552D135b8Da61c7f44cEFE93485c616d": 50000,
};

export const OPTION_SELLER = {
  ORBIT: "0x015b37a1E5dAd6259Fd623fbb0137b3cf2b435f3",
  ORBIT_TWO: "0x54c39a7FA0D8CAa251Bad55c7abeFA43BC8ba749",
};

export const PERFORMANCE_FEE = 15000000; // 15% per year
export const MANAGEMENT_FEE = 0; // 0% per year
