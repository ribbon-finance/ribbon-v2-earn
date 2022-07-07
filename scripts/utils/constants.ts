export const LOAN_TERM_LENGTH = BigNumber.from("28").mul(86400);
export const OPTION_PURCHASE_FREQ = BigNumber.from("7").mul(86400);
export const LOAN_ALLOCATION_PCT = BigNumber.from("9900");
export const OPTION_ALLOCATION_PCT = BigNumber.from("100");

export const BORROWER = {
  GENESIS: "",
  WINTERMUTE: "",
};

export const OPTION_SELLER = {
  ORBIT: "",
};

export const PERFORMANCE_FEE = 10000000;
export const MANAGEMENT_FEE = 2000000; // 2% per year. 2 * 10**6. Should result in 38356 per week.
