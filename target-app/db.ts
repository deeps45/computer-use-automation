export interface Account {
  type: "Savings" | "Checking";
  number: string;
  balance: number;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  dobMasked: string;
  branch: string;
  accounts: Account[];
}

// In-memory "core" — stands in for a mainframe/servicing DB with no API surface.
export const members: Record<string, Member> = {
  "12345": {
    id: "12345",
    firstName: "Jane",
    lastName: "Doe",
    dobMasked: "**/**/1988",
    branch: "Downtown",
    accounts: [
      { type: "Savings", number: "SV-8801-12345", balance: 2450.1 },
      { type: "Checking", number: "CK-4471-12345", balance: 310.55 },
    ],
  },
  "23456": {
    id: "23456",
    firstName: "Marcus",
    lastName: "Webb",
    dobMasked: "**/**/1975",
    branch: "Riverside",
    accounts: [{ type: "Savings", number: "SV-2290-23456", balance: 9820.0 }],
  },
  "34567": {
    id: "34567",
    firstName: "Priya",
    lastName: "Natarajan",
    dobMasked: "**/**/1992",
    branch: "Lakeview",
    accounts: [
      { type: "Savings", number: "SV-5510-34567", balance: 152.33 },
      { type: "Checking", number: "CK-1120-34567", balance: 40.0 },
    ],
  },
  // 40404 exists but is access-restricted -> permission-denial business outcome.
  "40404": {
    id: "40404",
    firstName: "Restricted",
    lastName: "Account",
    dobMasked: "**/**/1960",
    branch: "Legal Hold",
    accounts: [{ type: "Savings", number: "SV-0000-40404", balance: 0 }],
  },
};

let subAccountCounter = 9000;
export function nextSubAccountNumber(memberId: string) {
  subAccountCounter += 1;
  return `SA-${subAccountCounter}-${memberId}`;
}

interface PendingSubAccount {
  token: string;
  memberId: string;
  accountType: string;
  nickname: string;
  openingDeposit: number;
  createdAt: number;
}
export const pendingSubAccounts = new Map<string, PendingSubAccount>();
